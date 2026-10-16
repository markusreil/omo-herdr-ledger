import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const VIEWER = new URL('./viewer.mjs', import.meta.url);

function stateDir() {
  return join(homedir(), '.omo', 'agent', 'ledger');
}

// Offline archive of every request, grouped by day (local date) for later
// analysis. Each line is one request; `usage` carries the full provider
// `Usage` object including `cacheRead`/`cacheWrite`. NOTE: a request
// straddling midnight logs its start and completion into different files,
// leaving a dangling inflight entry in the old file (accepted, see TODO.md).
// Hook failures must never break the session, but total silence once hid
// a 54-minute archive hole — so they go to a debug log, not /dev/null.
async function debugLog(where, error) {
  try {
    const { mkdir, appendFile } = await import('node:fs/promises');
    await mkdir(stateDir(), { recursive: true, mode: 0o700 });
    await appendFile(join(stateDir(), 'debug.log'), `${new Date().toISOString()} ${where}: ${error?.message ?? error}\n`);
  } catch {
    // last resort: stay silent rather than break the host session
  }
}

function callsPath(date = new Date()) {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return join(stateDir(), `model-calls-${day}.jsonl`);
}

/**
 * `model` here is `BeforeProviderRequestEvent['model']`, i.e. a pi-ai chat
 * `Model<Api>` (may be undefined when the request has no resolved model).
 *
 * From `BaseModel` (every catalog entry has these):
 * - `id: string` — catalog id, e.g. `opencode-go/muse-spark-1.3-contributor`
 * - `name: string` — human-readable display name
 * - `api: string` — provider API flavor (`openai-completions`,
 *   `openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, …)
 * - `provider: ProviderId` — which provider serves it
 * - `baseUrl: string` — endpoint the request goes to
 * - `input: ("text" | "image" | "video")[]` — accepted input modalities
 * - `inputLimits?: ModelInputLimits` — `{ maxRequestBytes?, images? }`
 * - `cost: ModelCost` — `{ input, output, cacheRead, cacheWrite, tiers? }`
 *   ($/M tokens; `tiers?` holds volume-pricing thresholds)
 * - `headers?: Record<string, string>` — extra per-model headers
 *
 * Chat-only fields (`Model` extends `BaseModel`):
 * - `type?: "chat"` — usually absent (chat is the default type)
 * - `reasoning: boolean` — model can emit reasoning/thinking
 * - `thinkingLevelMap?: ThinkingLevelMap` — pi level → provider value
 * - `defaultThinkingLevel?: ModelThinkingLevel`
 * - `promptCache?: ModelPromptCache` — cache lifetimes per retention tier
 * - `contextWindow: number`, `maxTokens: number`
 * - `samplingParams?: Record<string, unknown>` — default sampling overrides
 * - `cacheRetention?: CacheRetention` (`none` | `short` | `long`)
 * - `upstreamModelId?: string` — wire id when it differs from catalog `id`
 * - `serviceTier?: "auto" | "flex" | "priority" | "ultrafast"`
 * - `recoverTextToolCalls?: boolean`, `supportsAssistantPrefill?: boolean`
 * - `compat?` — per-API compatibility overrides (shape depends on `api`)
 *
 * The sibling `payload: unknown` on the event is the raw provider request
 * body; `headers?: ProviderHeaders` is the final header transform output.
 */
function modelLabel(model) {
  if (!model) return '?';
  if (typeof model === 'string') return model;
  const id = model.id ?? model.model ?? model.name ?? '?';
  // Qualify with the provider (`opencode-go/muse-spark-…`) to match the
  // session card (`model_change` provider + modelId) and task records.
  const provider = model.provider;
  if (typeof provider === 'string' && provider && !id.includes('/')) return `${provider}/${id}`;
  return id;
}

// Best-effort trigger-prompt snippet: last user-role text in the request
// body. Responses API uses `payload.input[]`, Completions uses
// `payload.messages[]`; content may be a string or content blocks.
function payloadPrompt(payload, limit = 80) {
  const items = payload?.input ?? payload?.messages;
  if (!Array.isArray(items)) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || item.role !== 'user') continue;
    const content = item.content;
    let text = null;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter(part => typeof part?.text === 'string' || typeof part === 'string')
        .map(part => (typeof part === 'string' ? part : part.text))
        .join(' ');
    }
    if (!text) continue;
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    // Harness reminders travel as trailing user-role input; they are not
    // what the human said — skip them and keep scanning backwards.
    if (/^<(memory_notice|system-reminder|omo-senpi-task|environment_context|recalled-memory)/.test(text)) continue;
    // Task delivery notifications arrive as user-role messages too; the
    // human prompt is further back.
    if (/^task completion /.test(text)) continue;
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }
  return null;
}

function payloadBytes(payload) {
  if (payload === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(payload));
  } catch {
    return -1;
  }
}

// Each entry: `{ at, model, payloadBytes, done, completedAt?, usage? }`.
// `done: false` = inflight (request sent, response not yet received).
// `after_provider_response` flips the newest inflight entry to done; the
// later `message_end` patches `usage` onto the newest done entry lacking it.
// (Handler order per request is sequential on the event queue, so "newest
// matching entry" correlates correctly for non-overlapping requests.)
function currentSessionId(ctx) {
  try {
    return ctx?.sessionManager?.getSessionId?.() ?? null;
  } catch {
    return null;
  }
}

function sessionFileOf(ctx) {
  try {
    return ctx?.sessionManager?.getSessionFile?.() ?? null;
  } catch {
    return null;
  }
}

// Child (delegated) sessions live under `.../senpi-task/children/<taskId>/`;
// the task id joins model requests to their task record (category,
// description, run stats) the way the DAG pane does. Main sessions yield null.
function taskIdOfSessionFile(path) {
  if (typeof path !== 'string') return null;
  const match = path.match(/senpi-task\/children\/(st_[A-Za-z0-9_-]{1,253})(\/|$)/);
  return match ? match[1] : null;
}

function tasksDir() {
  const direct = process.env.OMO_TASKS_DIR || process.env.SENPI_TASKS_DIR;
  if (direct) return direct;
  const parent = process.env.OMO_HERDR_DAG_TASK_STATE_DIR;
  if (parent) return join(parent, 'tasks');
  return null;
}

function projectOf(ctx) {
  try {
    const cwd = ctx?.cwd;
    if (typeof cwd === 'string' && cwd) return cwd.split('/').filter(Boolean).pop() ?? null;
  } catch {
    // ignore
  }
  return null;
}

async function recordModelCall(model, payload, sessionId, taskId, prompt, project) {
  const entry = JSON.stringify({
    at: new Date().toISOString(),
    sessionId,
    taskId,
    project,
    model: modelLabel(model),
    // Serialized byte length of the raw provider request body. Token counts
    // are NOT available here — usage only arrives after the response, via
    // `message_end` (see below), which patches `usage` onto this entry.
    payloadBytes: payloadBytes(payload),
    prompt,
    done: false,
  });
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const { appendFile } = await import('node:fs/promises');
  // Inside the lock: a concurrent full-file rewrite (updateNewest) must
  // not drop an append that lands inside its read→write window.
  await withArchiveLock(async () => {
    await appendFile(callsPath(), `${entry}\n`, { mode: 0o600 });
  });
}

// Cross-process mutex for all archive mutations (several omo windows and
// in-process children share one archive file). mkdir is atomic: the winner
// creates the dir, losers retry. Stale locks (crashed holder) expire via
// mtime. Appends ride the same lock: a full-file rewrite from a stale read
// would otherwise drop an append landing inside its read→write window.
async function withArchiveLock(fn) {
  const { mkdir, rm, stat } = await import('node:fs/promises');
  const lock = `${callsPath()}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - (await stat(lock)).mtimeMs;
        if (age > 10000) await rm(lock, { recursive: true, force: true });
      } catch {
        // lock vanished mid-check; retry
      }
      if (Date.now() > deadline) throw new Error(`archive lock timeout: ${lock}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

async function updateNewest(predicate, patch) {
  const { readFile, writeFile } = await import('node:fs/promises');
  await withArchiveLock(async () => {
    let lines;
    try {
      lines = (await readFile(callsPath(), 'utf8')).split('\n');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (!predicate(entry)) continue;
        Object.assign(entry, patch);
        lines[i] = JSON.stringify(entry);
        break;
      } catch {
        continue;
      }
    }
    await writeFile(callsPath(), lines.join('\n'), { mode: 0o600 });
  });
}

async function markCompleted(sessionId, status) {
  await updateNewest(
    entry => entry.done === false && (sessionId == null || entry.sessionId === sessionId),
    { done: true, completedAt: new Date().toISOString(), status },
  );
}

// Patches `{ input, output, cacheRead, cacheWrite, reasoning?, totalTokens }`
// plus `cost` onto the most recent log entry that has none yet. Runs on
// `message_end` for assistant messages, which carry the provider-reported
// `usage` (pi-ai `Usage`; see model docs above for the cost shape).
async function recordUsage(usage, sessionId) {
  if (!usage) return;
  await updateNewest(
    entry => entry.done === true && entry.usage === undefined
      && (sessionId == null || entry.sessionId === sessionId),
    { usage },
  );
}

function herdrBin() {
  const fromEnv = process.env.HERDR_BIN_PATH;
  if (fromEnv && existsSync(fromEnv) && !fromEnv.endsWith('(deleted)')) return fromEnv;
  return 'herdr';
}

export function herdrSession() {
  if (process.env.HERDR_ENV !== '1') return false;
  if (!process.env.HERDR_PANE_ID || !process.env.HERDR_SOCKET_PATH) return false;
  try {
    if (!statSync(process.env.HERDR_SOCKET_PATH).isSocket()) return false;
  } catch {
    return false;
  }
  return true;
}

async function herdr(args) {
  const { stdout } = await run(herdrBin(), ['pane', ...args]);
  return stdout.trim();
}

// Pane state is per Herdr window (w34, w35, … from HERDR_PANE_ID): one
// global state.json meant sessions in different windows fought over a
// single pane — toggling in one window closed another's.
function windowId() {
  const match = (process.env.HERDR_PANE_ID ?? '').match(/^(w[0-9A-Za-z]+)/);
  return match ? match[1] : null;
}
function stateFile() {
  const window = windowId();
  return join(stateDir(), window ? `state-${window}.json` : 'state.json');
}
async function readState() {
  for (const file of [stateFile(), join(stateDir(), 'state.json')]) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return {};
}

async function writeState(state) {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await writeFile(stateFile(), JSON.stringify(state), { mode: 0o600 });
}

function ownPaneId() {
  return process.env.HERDR_PANE_ID ?? null;
}

// Never touch the pane omo itself runs in: an early build stored the
// main pane id as the ledger pane (parsePaneId fell through to the regex
// on split output mentioning the current pane), so session_start
// "reclaimed" the user's own pane by running the viewer where they type.
// A ledger pane id equal to our own is poisoned state: forget it.
async function guardSelfPane(paneId) {
  const own = ownPaneId();
  if (own && paneId === own) {
    await writeState({});
    return true;
  }
  return false;
}

async function paneAlive(paneId) {
  try {
    await herdr(['get', paneId]);
    return true;
  } catch {
    return false;
  }
}

function parsePaneId(output) {
  try {
    const parsed = JSON.parse(output);
    const id = parsed?.result?.pane?.pane_id;
    if (typeof id === 'string' && id) return id;
  } catch {
    // fall through to pattern match
  }
  const match = output.match(/w[0-9A-Za-z]+:p[0-9A-Za-z]+/);
  if (!match) throw new Error(`could not parse pane id from: ${output}`);
  return match[0];
}

export async function openPane(sessionId = null, sessionFile = null, dirOfTasks = null) {
  const output = await herdr(['split', '--current', '--direction', 'right', '--ratio', '0.65', '--no-focus']);
  const paneId = parsePaneId(output);
  if (await guardSelfPane(paneId)) throw new Error(`split returned our own pane (${paneId}); not running viewer there`);
  try {
    await herdr(['rename', paneId, 'Ledger']);
    await herdr(['run', paneId, 'node', VIEWER.pathname]);
  } catch (error) {
    try {
      await herdr(['close', paneId]);
    } catch {
      // closing the orphan is best-effort; report the original failure
    }
    throw error;
  }
  await writeState({ paneId, sessionId, sessionFile, tasksDir: dirOfTasks, openedAt: new Date().toISOString() });
  return paneId;
}

export async function closePane(paneId) {
  await herdr(['close', paneId]);
  await writeState({});
}

// A pane running our viewer that state.json doesn't know about (state wiped
// or pane opened by an older build). Adopt it instead of opening a second.
async function adoptOrphanViewer(sessionId, sessionFile, dirOfTasks) {
  let panes;
  try {
    panes = JSON.parse(await herdr(['list']))?.result?.panes ?? [];
  } catch {
    return null;
  }
  const window = windowId();
  for (const pane of panes) {
    const id = pane?.pane_id;
    if (typeof id !== 'string') continue;
    // Never adopt our own pane: it may run a stale viewer from a manual
    // `node viewer.mjs` invocation, and restarting it hijacks user input.
    if (ownPaneId() && id === ownPaneId()) continue;
    // Never steal another window's pane.
    if (window && !id.startsWith(`${window}:`)) continue;
    let procs;
    try {
      procs = JSON.parse(await herdr(['process-info', '--pane', id]))
        ?.result?.process_info?.foreground_processes ?? [];
    } catch {
      continue;
    }
    if (!procs.some(proc => (proc.cmdline ?? '').includes('ledger/viewer.mjs'))) continue;
    try {
      await herdr(['send-keys', id, 'ctrl+c']);
      await new Promise(resolve => setTimeout(resolve, 500));
      await herdr(['run', id, 'node', VIEWER.pathname]);
      await writeState({ paneId: id, sessionId, sessionFile, tasksDir: dirOfTasks, openedAt: new Date().toISOString() });
      return id;
    } catch {
      continue;
    }
  }
  return null;
}

export async function togglePane(sessionId = null, sessionFile = null, dirOfTasks = null) {
  const { paneId } = await readState();
  if (paneId && await guardSelfPane(paneId)) return { action: 'closed', paneId };
  if (paneId && (await paneAlive(paneId))) {
    await closePane(paneId);
    return { action: 'closed', paneId };
  }
  const adopted = await adoptOrphanViewer(sessionId, sessionFile, dirOfTasks);
  if (adopted) return { action: 'opened', paneId: adopted };
  const opened = await openPane(sessionId, sessionFile, dirOfTasks);
  return { action: 'opened', paneId: opened };
}

function isChildSession(ctx) {
  const file = sessionFileOf(ctx) ?? '';
  return /[/\\]senpi-task[/\\]children[/\\]/.test(file);
}

// Reclaim a pane left over from before a reload: interrupt its stale viewer
// and start the current one in place, keeping the pane where it is. Runs on
// every session start so a forgotten toggle-off never strands a pane.
async function reclaimPane(ctx) {
  if (isChildSession(ctx)) return;
  const { paneId } = await readState();
  // omo restarted inside its own old ledger pane (main pane quit, ledger
  // was the only pane left, user re-ran omo there): take the pane over as
  // the main pane instead of running the viewer where the user types.
  // Closing it is not an option — this session lives here now. `guardSelfPane`
  // already forgot the poisoned state; just say so.
  if (paneId && await guardSelfPane(paneId)) {
    try {
      ctx?.ui?.notify?.('Ledger pane taken over as main pane (/ledger to reopen)', 'info');
    } catch {
      // notify is best-effort on the startup path
    }
    return;
  }
  if (!paneId || !(await paneAlive(paneId))) {
    if (paneId) await writeState({});
    return;
  }
  try {
    await herdr(['send-keys', paneId, 'ctrl+c']);
    await new Promise(resolve => setTimeout(resolve, 500));
    await herdr(['run', paneId, 'node', VIEWER.pathname]);
    await writeState({
      paneId,
      sessionId: currentSessionId(ctx),
      sessionFile: sessionFileOf(ctx),
      tasksDir: tasksDir(),
      openedAt: new Date().toISOString(),
    });
  } catch {
    // best-effort; the toggle command remains the manual fallback
  }
}

export default function extension(pi) {
  /**
   * Callback event: `before_provider_request` (`BeforeProviderRequestEvent`).
   * Fired once per provider HTTP request, after auth/base-url/upstream-model
   * resolution and before the request is sent — i.e. every model invocation,
   * including retries, compaction calls, and auxiliary (non-main-loop) calls.
   *
   * Event shape:
   * - `type: "before_provider_request"` — discriminant
   * - `payload: unknown` — the raw provider request body about to go on the
   *   wire (shape depends on the provider `api` flavor)
   * - `model?: Model<Api>` — effective resolved model (see `modelLabel` docs
   *   for its fields); absent when no model resolved for the request
   * - `headers?: ProviderHeaders` — final header transform output
   *   (`Record<string, string | null>`; never persisted)
   *
   * Handler contract (`ExtensionHandler<BeforeProviderRequestEvent,
   * BeforeProviderRequestEventResult>`): `(event, ctx) => result | void`.
   * `BeforeProviderRequestEventResult` is `unknown` — the return value is
   * accepted but ignored by this event (unlike e.g. `tool_call`, where
   * returning `{ block: true }` blocks execution). Keep the handler sync and
   * non-throwing; async side effects (here: the log append) must be
   * fire-and-forget with their own `.catch()`, otherwise a rejection
   * surfaces as an `Event handler error (before_provider_request)`.
   */
  try {
    pi.on('before_provider_request', (event, ctx) => {
      const file = sessionFileOf(ctx);
      recordModelCall(event?.model, event?.payload, currentSessionId(ctx), taskIdOfSessionFile(file), payloadPrompt(event?.payload), projectOf(ctx)).catch(error => debugLog('recordModelCall', error));
    });
    // `after_provider_response` fires once the provider HTTP response
    // arrives (`{ type, status, headers }`), before stream consumption.
    pi.on('after_provider_response', (event, ctx) => {
      markCompleted(currentSessionId(ctx), event?.status).catch(error => debugLog('markCompleted', error));
    });
    pi.on('message_end', (event, ctx) => {
      if (event?.message?.role !== 'assistant') return;
      recordUsage(event?.message?.usage, currentSessionId(ctx)).catch(error => debugLog('recordUsage', error));
    });
  } catch {
    // hook registration is best-effort; the pane toggle must keep working
  }
  if (!herdrSession()) return;
  pi.on('session_start', (_event, ctx) => {
    reclaimPane(ctx).catch(error => debugLog('reclaimPane', error));
  });
  pi.registerCommand('ledger', {
    description: 'Toggle the Ledger side pane',
    handler: async (_args, ctx) => {
      try {
        const result = await togglePane(currentSessionId(ctx), sessionFileOf(ctx), tasksDir());
        ctx.ui.notify(`Ledger pane ${result.action} (${result.paneId})`, 'info');
      } catch (error) {
        ctx.ui.notify(`Ledger pane failed: ${error.message}`, 'error');
      }
    },
  });
}
