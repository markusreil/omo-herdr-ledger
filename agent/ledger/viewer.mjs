import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { emitKeypressEvents } from 'node:readline';
import { charW, cutTo, dayName, emptyAgg, foldAgg, fmtCost, fmtCount, fmtDur, fmtElapsed, fmtLen, fmtLocal, fmtSize, groupCalls, historyBuckets, latencySecs, midEllipsis, MODEL_MAX, normProject, overallToday, padTo, projectLeaf, shedProfile, textWidth } from './stats.mjs';

const DIR = join(homedir(), '.omo', 'agent', 'ledger');
// Mirrors the extension's per-window state (state-<window>.json from
// HERDR_PANE_ID) with legacy state.json fallback — same order as readState.
function windowId() {
  const match = (process.env.HERDR_PANE_ID ?? '').match(/^(w[0-9A-Za-z]+)/);
  return match ? match[1] : null;
}
function stateFile() {
  const window = windowId();
  return join(DIR, window ? `state-${window}.json` : 'state.json');
}
const STATE = stateFile();
const STATE_FALLBACK = join(DIR, 'state.json');

function callsPath(date = new Date()) {
  return join(DIR, `model-calls-${dayName(date)}.jsonl`);
}

async function readJsonLines(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n').filter(Boolean).map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readState() {
  for (const file of STATE === STATE_FALLBACK ? [STATE] : [STATE, STATE_FALLBACK]) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      // missing/unparseable: try the fallback, then give up
    }
  }
  return {};
}

// Overall stats: today's file is aggregated live on every refresh, while
// previous days are frozen (only today's file is ever appended to), so
// each past day is squashed once at startup into a single summary line.
async function squashPastDays(todayName) {
  const days = [];
  let files;
  try {
    files = await readdir(DIR);
  } catch {
    return days;
  }
  for (const file of files.filter(f => /^model-calls-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
    if (file === todayName) continue;
    const day = file.slice('model-calls-'.length, -'.jsonl'.length);
    const byProject = new Map();
    for (const call of await readJsonLines(join(DIR, file))) {
      if (call.done !== true) continue;
      const project = call.project ?? '?';
      if (!byProject.has(project)) byProject.set(project, emptyAgg());
      foldAgg(byProject.get(project), call);
    }
    for (const [project, agg] of byProject) days.push({ day, project, ...agg });
  }
  return days;
}
let pastDaysCache = null;
let pastDaysCacheFile = null;
async function pastDaysCached(todayFile) {
  if (!pastDaysCache || pastDaysCacheFile !== todayFile) {
    pastDaysCache = await squashPastDays(todayFile);
    pastDaysCacheFile = todayFile;
  }
  return pastDaysCache;
}
// Machine-wide per-model totals live in stats.mjs overallToday.

// Own-session summary from its session JSONL: model history, turns
// (assistant messages), tool calls (toolCall blocks), summed usage + cost.
async function sessionStats(sessionFile) {
  const stats = { turns: 0, toolCalls: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  if (!sessionFile) return stats;
  let lastModel;
  for (const entry of await readJsonLines(sessionFile)) {
    if (entry.type === 'session' && !stats.startedAt) {
      stats.startedAt = entry.timestamp;
      stats.cwd = entry.cwd;
      stats.id = entry.id;
    }
    if (entry.type === 'model_change' && entry.modelId) {
      lastModel = `${entry.provider ?? '?'}/${entry.modelId}`;
    }
    const message = entry.message;
    if (entry.type !== 'message' || !message || message.role !== 'assistant') continue;
    stats.turns++;
    const usage = message.usage;
    if (usage) {
      stats.in += usage.input ?? 0;
      stats.out += usage.output ?? 0;
      stats.cacheRead += usage.cacheRead ?? 0;
      stats.cacheWrite += usage.cacheWrite ?? 0;
      const cost = usage.cost;
      stats.cost += typeof cost === 'number' ? cost : (cost?.total ?? 0);
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'toolCall') stats.toolCalls++;
      }
    }
  }
  if (lastModel) stats.model = lastModel;
  return stats;
}

// Session file for a delegated child, found by child session id. Lets us
// compute live turns/tool calls/tokens while the task record has no
// run_stats yet (running tasks carry neither run_stats nor live_progress).
async function childSessionFile(tasksDir, taskId) {
  if (typeof tasksDir !== 'string' || !tasksDir || typeof taskId !== 'string' || !taskId) return null;
  // Delegated sessions live under the tasks dir's siblings:
  // `<tasksDir>/../children/<taskId>/sessions/<taskId>/*.jsonl`.
  // Prefer the newest match: a child session rotates files per turn.
  const base = join(tasksDir, '..', 'children', taskId, 'sessions', taskId);
  let files;
  try {
    files = await readdir(base);
  } catch {
    return null;
  }
  let newest = null, newestTime = -1;
  for (const file of files.filter(f => f.endsWith('.jsonl'))) {
    const full = join(base, file);
    let time = -1;
    try {
      time = (await stat(full)).mtimeMs;
    } catch {
      continue;
    }
    if (time > newestTime) {
      newestTime = time;
      newest = full;
    }
  }
  return newest;
}

// Child tasks spawned by this session, DAG-style normalized from task JSON.
// Every tasks dir on the machine (one per project). Overall folds tasks
// from all of them so every window shows identical machine-wide totals.
async function allTasksDirs() {
  let projects;
  try {
    projects = await readdir(join(homedir(), '.omo', 'agent', 'projects'));
  } catch {
    return [];
  }
  return projects.map(p => join(homedir(), '.omo', 'agent', 'projects', p, 'senpi-task', 'tasks'));
}
async function normalizeTask(raw, tasksDir) {
  if (!raw || typeof raw.task_id !== 'string') return null;
    const runStats = raw.run_stats ?? {};
    let turns = runStats.turns;
    let toolCalls = runStats.tool_calls;
    // run_stats.turns equals provider request count (verified: 40 turns =
    // dashboard req=40 for the review task), so folded rows get real reqs.
    // Usage for the task card and Overall: finished tasks report run_stats;
    // running tasks have none yet, so fall back to the child session file.
    let usage = runStats.input_tokens !== undefined ? {
      in: runStats.input_tokens ?? 0,
      out: runStats.output_tokens ?? 0,
      cacheRead: runStats.cache_read_tokens ?? 0,
      cacheWrite: 0,
      cost: runStats.cost_usd ?? 0,
    } : null;
    let liveUsage = null;
    if ((turns === undefined || toolCalls === undefined || usage === null) && typeof raw.task_id === 'string') {
      const file = await childSessionFile(tasksDir, raw.task_id);
      if (file) {
        const stats = await sessionStats(file);
        turns ??= stats.turns;
        toolCalls ??= stats.toolCalls;
        liveUsage = stats;
        usage ??= { in: stats.in, out: stats.out, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite, cost: stats.cost };
      }
    }
    const resolved = raw.resolved_model ?? {};
    const usageModel = typeof resolved.provider === 'string' && typeof resolved.model_id === 'string'
      ? `${resolved.provider}/${resolved.model_id}` : null;
    return {
      id: raw.task_id,
      parentSessionId: raw.parent_session_id ?? null,
      project: projectLeaf(tasksDir),
      description: raw.task_summary ?? raw.name ?? raw.task_id,
      agent: raw.category ?? raw.agent_type ?? '?',
      model: raw.resolved_model?.display ?? raw.model ?? '?',
      status: raw.status ?? '?',
      startedAt: raw.started_at ?? raw.created_at,
      completedAt: raw.terminal_at,
      turns,
      toolCalls,
      liveUsage,
      usage,
      usageModel,
      // Live session-file turn counts overcount (rotated files), so only
      // reported run_stats.turns qualifies as a request count.
      reqCount: runStats.turns ?? null,
    };
}
async function readTasksDir(tasksDir) {
  let files;
  try {
    files = await readdir(tasksDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const tasks = [];
  for (const file of files.filter(f => f.endsWith('.json'))) {
    let raw;
    try {
      raw = JSON.parse(await readFile(join(tasksDir, file), 'utf8'));
    } catch {
      continue;
    }
    const task = await normalizeTask(raw, tasksDir);
    if (task) tasks.push(task);
  }
  return tasks;
}
// Active goal for this session, if the goal extension has one.
// Stored as `~/.omo/agent/sessions/<slug>/extensions/goal/<sessionId>.json`;
// matched by full id or 8-char prefix. Best-effort: null when absent.
async function activeGoal(sessionId) {
  if (!sessionId) return null;
  const base = join(homedir(), '.omo', 'agent', 'sessions');
  let slugs;
  try {
    slugs = await readdir(base);
  } catch {
    return null;
  }
  const short = String(sessionId).slice(0, 8);
  for (const slug of slugs) {
    const dir = join(base, slug, 'extensions', 'goal');
    let files;
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    const match = files.find(f => f === `${sessionId}.json` || f.startsWith(`${short}`) && f.endsWith('.json'));
    if (!match) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, match), 'utf8'));
      const goal = raw?.goal ?? raw;
      if (goal && (goal.status === 'active' || goal.objective)) return goal;
    } catch {
      continue;
    }
  }
  return null;
}
async function childTasks(tasksDir, sessionId) {
  if (!tasksDir || !sessionId) return [];
  const tasks = (await readTasksDir(tasksDir)).filter(task => task.parentSessionId === sessionId);
  tasks.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
  return tasks;
}
// Every task on the machine, for the machine-wide Overall fold.
async function allTasks() {
  const tasks = [];
  for (const dir of await allTasksDirs()) {
    tasks.push(...await readTasksDir(dir));
  }
  return tasks;
}

// Request lane pace + throughput cells: latency (`6.3s`, inflight
// `34s …`) always renders; the `· 1.4k t/s` rate sheds first on narrow
// panes (see shedProfile).
function paceCells(call) {
  const secs = latencySecs(call);
  if (secs !== null) {
    const out = call.usage?.output;
    const rate = typeof out === 'number' && secs > 0 ? Math.round(out / secs) : 0;
    return { pace: fmtLen(secs), rate: rate >= 1 ? `${fmtCount(rate)} t/s` : '' };
  }
  // Inflight: count up from the start time; the 2s refresh ticks it live.
  const start = new Date(call.at ?? NaN).getTime();
  if (!Number.isFinite(start)) return { pace: '?', rate: '' };
  return { pace: `${fmtLen(Math.max(0, (Date.now() - start) / 1000))} …`, rate: '' };
}

// Non-2xx responses are flagged inline; 2xx/unknown stay quiet. Plain
// text — the lane cell pads first and paints after.
function flagText(call) {
  const status = call.status;
  if (!Number.isFinite(status)) return '';
  if (status >= 200 && status < 300) return '';
  return `!${status}`;
}

// Presentation palette — applied only in interactive TTY mode so piped
// output stays plain. `·` separators, marks and labels follow the
// viewer's existing language; colors only add emphasis.
const paint = (code, text) => (interactive ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = text => paint('2', text);
const bold = text => paint('1', text);
const accent = text => paint('36', text);
const good = text => paint('32', text);
const warn = text => paint('33', text);
const bad = text => paint('31', text);
// Selection wraps a whole cell that may already carry dim/accent
// segments; their `\x1b[0m` resets would end the bold mid-cell, so
// re-assert it after every inner reset.
const em = (isSelected, text) => (isSelected ? paint('1', String(text).replaceAll('\x1b[0m', '\x1b[0m\x1b[1m')) : text);

// ── Single-lane layout ─────────────────────────────────────────────────────
// Collapsed rows are assembled from fixed-width cells — one column per
// field — so every field lines up across rows at any pane width; the
// snippet/name cell absorbs the slack. Cells pad on visible width and
// paint after padding, so ANSI escapes never break alignment. fitWidth
// remains only as the no-wrap backstop; expanded detail blocks and their
// full ids are never cut.
const W = {
  cursor: 2,  // '> ' / '  ' selection gutter (carries its own space)
  mark: 1,    // '✓' / '…' / '?' status mark
  badge: 4,   // '×12' group size
  size: 5,    // payload bytes (fmtSize)
  pace: 6,    // '6.3s' latency, inflight '34s …'
  rate: 10,   // '· 1.4k t/s' throughput
  in: 7,      // 'in=2.5M'
  out: 8,     // 'out=2.5M'
  req: 9,     // 'req=12345' (floor; grows for wider data)
  meter: 9,   // 'time=22m' / 'days=3'
  cost: 9,    // '· $0.0123' (floor; grows for wider data)
};
// Flexible slots: the snippet/name column shrinks to these before any
// fixed field gives way.
const SNIP_MIN = 10;
const SNIP_MAX = 56;
const NAME_MIN = 5;
const DESC_MIN = 10;
// Width of a run of cells joined by single spaces (0 = the flexible
// snippet/name slot, which still costs its separator).
const laneW = cells => cells.reduce((w, c) => w + c, 0) + Math.max(0, cells.length - 1);
// Plain cell padded on visible width (no inner paint).
const cell = (text, w, align = 'left') => {
  const pad = Math.max(0, w - textWidth(text));
  return align === 'right' ? ' '.repeat(pad) + text : text + ' '.repeat(pad);
};
// `label=value` field with a dim label, padded to w on visible width.
const field = (label, value, w, align = 'left') => {
  const pad = Math.max(0, w - textWidth(`${label}${value}`));
  const body = `${dim(label)}${value}`;
  return align === 'right' ? ' '.repeat(pad) + body : body + ' '.repeat(pad);
};
// Painted cell: pad plain first, then color the glyphs.
const paintCell = (paintFn, text, w, align = 'left') => (text ? paintFn(cell(text, w, align)) : cell('', w, align));

// `label:` column for expanded detail blocks: longest label
// (`completed:`) plus one gap space.
const LABEL_W = 11;
const kv = (label, value, indent = '      ') =>
  `${indent}${dim(label.padEnd(LABEL_W))}${value}`;

// A task counts as active while it can still change; active tasks render
// expanded automatically and collapse once they settle (their manual fold
// state is forgotten at that point so finished cards start collapsed).
const taskActive = status => status === 'running' || status === 'working';
const taskKey = id => `task:${id}`;
const prevTaskStatus = new Map();
function syncTaskExpansion(tasks) {
  const seen = new Set();
  for (const task of tasks) {
    seen.add(task.id);
    const was = prevTaskStatus.get(task.id);
    if (taskActive(task.status)) expanded.add(taskKey(task.id));
    else if (was !== undefined && taskActive(was)) expanded.delete(taskKey(task.id));
    prevTaskStatus.set(task.id, task.status);
  }
  for (const id of [...prevTaskStatus.keys()]) {
    if (!seen.has(id)) {
      prevTaskStatus.delete(id);
      expanded.delete(taskKey(id));
    }
  }
}
function taskExpanded(task) {
  return taskActive(task.status) || expanded.has(taskKey(task.id));
}

let selected = 0;
const expanded = new Set();
let overallScope = 'machine';

async function snapshot() {
  const state = await readState();
  const sessionId = state.sessionId ?? null;
  const todayFile = `model-calls-${dayName()}.jsonl`;
  const allCalls = await readJsonLines(join(DIR, todayFile));
  const calls = allCalls.filter(call => (call.sessionId ?? null) === sessionId);
  // Reaping: a response normally lands within seconds, so an entry still
  // inflight after STALE_MS lost its completion hooks (error paths don't
  // always fire them). Stale entries leave the inflight count and render
  // dimmed instead of ticking forever.
  const STALE_MS = 10 * 60 * 1000;
  // Flushed from display an hour later. The log file keeps everything —
  // flushing is display-only, so offline analysis still sees them.
  const FLUSH_MS = 60 * 60 * 1000;
  const now = Date.now();
  const ageMs = call => now - new Date(call.at ?? NaN).getTime();
  const isStale = call => {
    const age = ageMs(call);
    return Number.isFinite(age) && age > STALE_MS;
  };
  const isFlushed = call => {
    const age = ageMs(call);
    return Number.isFinite(age) && age > STALE_MS + FLUSH_MS;
  };
  const inflight = calls.filter(call => call.done !== true && !isStale(call));
  const stale = calls.filter(call => call.done !== true && isStale(call) && !isFlushed(call));
  const completed = calls.filter(call => call.done === true);
  const groups = groupCalls(completed);
  const tasks = await childTasks(state.tasksDir, sessionId);
  const goal = await activeGoal(sessionId);
  const machineTasks = await allTasks();
  const session = await sessionStats(state.sessionFile);
  const paneProject = (typeof session.cwd === 'string' && session.cwd ? session.cwd.split('/').filter(Boolean).pop() : null)
    ?? projectLeaf(state.tasksDir);
  return {
    state,
    session,
    goal,
    paneProject,
    inflight,
    groups: groups.slice(-5).reverse(),
    completedTotal: completed.length,
    stale,
    tasks,
    overall: overallToday(allCalls, machineTasks),
    pastDays: await pastDaysCached(todayFile),
    history: historyBuckets(await pastDaysCached(todayFile), dayName(),
      overallScope === 'dir' ? normProject(paneProject) : null),
  };
}

// Flat selectable items: session card, then requests, then tasks.
function itemsOf(snap) {
  const items = [{ kind: 'session' }];
  for (const call of snap.inflight) items.push({ kind: 'request', call });
  for (const group of snap.groups) items.push({ kind: 'group', group });
  for (const call of snap.stale) items.push({ kind: 'stale', call });
  for (const task of snap.tasks) items.push({ kind: 'task', task });
  for (const bucket of snap.history ?? []) items.push({ kind: 'bucket', bucket });
  return items;
}

function render(snap, colsOverride) {
  const cols = colsOverride ?? process.stdout.columns ?? 0;
  // Usable lane is a column narrower than `cols` (pane border/padding;
  // draw() caps collapsed rows at cols-1). Budget layout to the lane so
  // an exact-fit row never loses its last cell (e.g. the agent tag `]`).
  const budget = cols > 0 ? cols - 1 : 0;
  // One lane per collapsed row: fixed-width cells per field (see W), the
  // snippet/name slot takes the slack. shedProfile drops optional cells
  // for the whole render at once, so the grid never breaks between rows.
  const prof = shedProfile(cols);
  const lines = [];
  const noFit = new Set();
  const markDetail = fn => { const from = lines.length; fn(); for (let i = from; i < lines.length; i++) noFit.add(i); };
  const items = itemsOf(snap);
  if (selected >= items.length) selected = Math.max(0, items.length - 1);
  const cursor = index => (index === selected ? accent('> ') : '  ');
  const on = index => index === selected;
  let index = 0;

  // Session card: id + model on the headline, stats below, expandable
  // detail. The headline model shrinks to the lane (middle ellipsis,
  // never tail-cut); its full id renders in the detail block.
  const session = snap.session;
  const sid = String(session.id ?? snap.state.sessionId ?? '?').slice(0, 8);
  const modelW = budget > 0 ? Math.max(8, Math.min(MODEL_MAX, budget - 21)) : MODEL_MAX;
  lines.push(`${cursor(index)}${em(on(index), 'Session')} ${accent(sid)} ${dim('·')} ${em(on(index), midEllipsis(session.model ?? '?', modelW))}`);
  if (expanded.has('session')) { markDetail(() => {
    lines.push(kv('model:', session.model ?? '?', '    '));
    lines.push(kv('started:', `${fmtLocal(session.startedAt)} ${dim('· elapsed:')} ${session.startedAt ? fmtElapsed(session.startedAt) : '?'}`, '    '));
    lines.push(kv('cwd:', session.cwd ?? '?', '    '));
    lines.push(kv('turns:', `${session.turns} ${dim('· tool calls:')} ${session.toolCalls}`, '    '));
    lines.push(kv('tokens:', `${dim('in=')}${fmtCount(session.in)} ${dim('out=')}${fmtCount(session.out)} ${dim('cacheR=')}${fmtCount(session.cacheRead)} ${dim('cacheW=')}${fmtCount(session.cacheWrite)}`, '    '));
    lines.push(kv('cost:', fmtCost(session.cost), '    '));
    if (snap.goal?.objective) lines.push(kv('goal:', snap.goal.objective, '    '));
    });
  } else {
    // Summary lane sheds extras (tools, then in=) with the ladder;
    // turns:, out= and cost always stay.
    const parts = [`${dim('turns:')} ${session.turns}`];
    if (prof.in) parts.push(`${dim('tools:')} ${session.toolCalls}`);
    parts.push(prof.in
      ? `${dim('in=')}${fmtCount(session.in)} ${dim('out=')}${fmtCount(session.out)}`
      : `${dim('out=')}${fmtCount(session.out)}`);
    parts.push(fmtCost(session.cost));
    lines.push(`    ${parts.join(` ${dim('·')} `)}`);
  }
  if (snap.goal?.objective) {
    const done = /complete|done|achieved/i.test(String(snap.goal.status ?? ''));
    const mark = done ? good('✓ goal:') : warn('◉ goal:');
    const goalText = budget > 0
      ? cutTo(snap.goal.objective, Math.max(10, budget - 12), true)
      : cutTo(snap.goal.objective, 80, true);
    lines.push(`    ${mark} ${done ? good(goalText) : goalText}`);
  }
  index++;

  // Requests: one row per prompt. Consecutive completed calls sharing
  // prompt + model collapse into a group row (expand for the individual
  // calls); inflight calls always render single with a live counter.
  // Model subheaders appear only for mixed-model lists.
  lines.push('');
  lines.push(`${bold('Requests')} ${dim(`(inflight: ${snap.inflight.length}, completed: ${snap.completedTotal}${snap.stale.length ? `, stale: ${snap.stale.length}` : ''})`)}`);
  // Request lane cells: mark · snippet “…” · ×n · size · pace · [rate] ·
  // [in=] out= · [!status] · [task tag]. Everything but the snippet is
  // fixed-width; the ×n badge owns its own cell so grouped and single
  // rows share one grid. Flag and tag gutters size to the widest one
  // present this render — a row carrying `!503` or a task tag must never
  // push out= past the lane edge.
  const reqCalls = [...snap.inflight, ...snap.groups.flatMap(g => g.calls)];
  const tagText = call => (call.taskId && prof.tags ? `[${midEllipsis(call.taskId, 12)}]` : '');
  const badgeW = Math.max(W.badge, ...snap.groups.map(g => textWidth(`×${g.calls.length}`)));
  const flagW = Math.max(0, ...reqCalls.map(call => textWidth(flagText(call))));
  const tagW = Math.max(0, ...reqCalls.map(call => textWidth(tagText(call))));
  const reqCellsFor = p => [W.mark, 0, badgeW, ...(p.pace ? [W.size, W.pace] : []),
    ...(p.tps ? [W.rate] : []), ...(p.in ? [W.in] : []), W.out,
    ...(flagW ? [flagW] : []), ...(tagW ? [tagW] : [])];
  // The lane must fit its fixed cells plus a minimally readable snippet;
  // when even the shed profile cannot do that, the emergency tier
  // (size/pace) cedes the lane — out= and the flag never do.
  let laneProf = prof;
  let reqCells = reqCellsFor(prof);
  if (budget > 0 && W.cursor + laneW(reqCells) + SNIP_MIN > budget) {
    laneProf = { ...prof, pace: false };
    reqCells = reqCellsFor(laneProf);
  }
  const snippetW = budget > 0
    ? Math.max(SNIP_MIN, Math.min(SNIP_MAX, budget - W.cursor - laneW(reqCells)))
    : 42;
  const promptCol = raw => cell(`“${cutTo(raw, Math.max(6, snippetW - 2), true)}”`, snippetW);
  // Usage cells keep their column even when a value is unknown (`?`) or
  // the request is still inflight — the grid holds for every row.
  const usageCells = usage => [
    ...(prof.in ? [field('in=', usage ? (usage.input === undefined ? '?' : fmtCount(usage.input)) : '?', W.in)] : []),
    field('out=', usage ? (usage.output === undefined ? '?' : fmtCount(usage.output)) : '?', W.out),
  ];
  const callIdentity = call => call.prompt ?? (call.at ?? '').slice(11, 19);
  const detailCall = call => {
    const done = call.done === true;
    const http = Number.isFinite(call.status) ? ` ${dim('· HTTP')} ${call.status}` : '';
    lines.push(kv('at:', fmtLocal(call.at)));
    lines.push(kv('status:', done ? `${dim('done at')} ${call.completedAt ?? '?'}${http}` : warn('inflight')));
    lines.push(kv('model:', call.model ?? '?'));
    if (call.taskId) lines.push(kv('task:', accent(call.taskId)));
    if (call.usage) {
      const usage = call.usage;
      lines.push(kv('usage:', `${dim('in=')}${usage.input} ${dim('out=')}${usage.output} ${dim('cacheR=')}${usage.cacheRead} ${dim('cacheW=')}${usage.cacheWrite} ${dim('reasoning=')}${usage.reasoning ?? '?'}`));
      const cost = usage.cost;
      lines.push(kv('cost:', `$${typeof cost === 'number' ? cost.toFixed(4) : (typeof cost?.total === 'number' ? cost.total.toFixed(4) : '?')}`));
    }
  };
  const renderCall = call => {
    const key = `req:${call.at}:${call.model}`;
    const done = call.done === true;
    const mark = done ? good('✓') : warn('…');
    const { pace, rate } = paceCells(call);
    const cells = [
      mark,
      promptCol(callIdentity(call)),
      cell('', badgeW),
      ...(laneProf.pace ? [cell(fmtSize(call.payloadBytes), W.size, 'right'), cell(pace, W.pace, 'right')] : []),
      ...(prof.tps ? [dim(cell(rate ? `· ${rate}` : '', W.rate))] : []),
      ...usageCells(call.usage),
      ...(flagW ? [paintCell(bad, flagText(call), flagW)] : []),
      ...(tagW ? [paintCell(accent, tagText(call), tagW)] : []),
    ];
    lines.push(`${cursor(index)}${em(on(index), cells.join(' '))}`);
    if (expanded.has(key)) markDetail(() => detailCall(call));
    index++;
  };
  const renderGroup = group => {
    const groupPrompt = group.prompt ?? (group.calls[0]?.at ?? '').slice(11, 19);
    const key = `grp:${group.calls[0]?.at}:${group.prompt}`;
    const n = group.calls.length;
    let bytes = 0, secs = 0, input = 0, output = 0, badStatus = null;
    const taskIds = new Set();
    for (const call of group.calls) {
      bytes += call.payloadBytes ?? 0;
      const latency = latencySecs(call);
      if (latency !== null) secs += latency;
      input += call.usage?.input ?? 0;
      output += call.usage?.output ?? 0;
      const status = call.status;
      if (Number.isFinite(status) && (status < 200 || status >= 300)) badStatus = status;
      if (call.taskId) taskIds.add(call.taskId);
    }
    const rate = secs > 0 ? Math.round(output / secs) : 0;
    const flag = badStatus !== null ? `!${badStatus}` : '';
    const who = taskIds.size === 1 && prof.tags ? `[${midEllipsis([...taskIds][0], 12)}]` : '';
    const cells = [
      good('✓'),
      promptCol(groupPrompt),
      cell(n > 1 ? `×${n}` : '', badgeW),
      ...(laneProf.pace ? [cell(fmtSize(bytes), W.size, 'right'), cell(fmtLen(secs), W.pace, 'right')] : []),
      ...(prof.tps ? [dim(cell(rate >= 1 ? `· ${fmtCount(rate)} t/s` : '', W.rate))] : []),
      ...usageCells({ input, output }),
      ...(flagW ? [paintCell(bad, flag, flagW)] : []),
      ...(tagW ? [paintCell(accent, who, tagW)] : []),
    ];
    lines.push(`${cursor(index)}${em(on(index), cells.join(' '))}`);
    if (expanded.has(key)) markDetail(() => {
      for (const call of group.calls) detailCall(call);
    });
    index++;
  };
  // Rows keep chronological order; mixed-model lists gain a subheader.
  const rows = [...snap.inflight.map(call => ({ kind: 'call', call, model: call.model ?? '?' })),
    ...snap.groups.map(group => ({ kind: 'group', group, model: group.model }))];
  const models = [...new Set(rows.map(row => row.model))];
  const renderRow = row => (row.kind === 'call' ? renderCall(row.call) : renderGroup(row.group));
  if (models.length > 1) {
    for (const model of models) {
      const theirs = rows.filter(row => row.model === model);
      lines.push(`  ${dim(`${midEllipsis(model)} (${theirs.length})`)}`);
      for (const row of theirs) renderRow(row);
    }
  } else {
    for (const row of rows) renderRow(row);
  }
  if (snap.inflight.length === 0 && snap.groups.length === 0 && snap.stale.length === 0) lines.push(`  ${dim('(none yet)')}`);
  for (const call of snap.stale) {
    const key = `stale:${call.at}:${call.model}`;
    const ageMs = Date.now() - new Date(call.at ?? NaN).getTime();
    const age = Number.isFinite(ageMs) ? fmtLen(ageMs / 1000) : '?';
    const cells = [
      dim('?'),
      dim(promptCol(callIdentity(call))),
      cell('', badgeW),
      ...(laneProf.pace ? [dim(cell(fmtSize(call.payloadBytes), W.size, 'right'))] : []),
      dim(cell(`${age} ago`, W.pace + 2, 'right')),
    ];
    lines.push(`${cursor(index)}${em(on(index), cells.join(' '))}`);
    if (expanded.has(key)) markDetail(() => detailCall(call));
    index++;
  }

  // Task cards: description primary, agent dim at a fixed column,
  // expandable detail. Status marks vary in width, so the mark column
  // sizes to the widest mark in the list.
  lines.push('');
  lines.push(`${bold('Tasks')} ${dim(`(${snap.tasks.length})`)}`);
  if (snap.tasks.length === 0) lines.push(`  ${dim('(none)')}`);
  const statusWord = status =>
    status === 'completed' ? good(status)
    : taskActive(status) ? warn(status)
    : /fail|error|cancel/i.test(String(status)) ? bad(status)
    : dim(status);
  const taskMarkText = task => task.status === 'completed' ? '✓'
    : taskActive(task.status) ? '…'
    : `(${task.status})`;
  const taskMarkPaint = task => task.status === 'completed' ? good
    : taskActive(task.status) ? warn
    : /fail|error|cancel/i.test(String(task.status)) ? bad
    : dim;
  const markW = Math.max(1, ...snap.tasks.map(task => textWidth(taskMarkText(task))));
  // The agent tag is the shed-first field: it shrinks before the
  // description drops below readable, and its full value lives in the
  // expanded detail block.
  const agentWFull = Math.max(3, ...snap.tasks.map(task => textWidth(`[${task.agent}]`)));
  const agentW = budget > 0
    ? Math.min(agentWFull, Math.max(3, budget - W.cursor - markW - DESC_MIN - 2))
    : agentWFull;
  // Collapsed = single lane: status, description and agent stay; model,
  // usage and elapsed live in the expanded detail. descW is the slack
  // slot: it takes exactly what the fixed cells leave (floor 0 — DESC_MIN
  // only steers the agent shrink above), so the row is never wider than
  // `budget` and the trailing `]` of the agent tag can't be cut off.
  const descW = budget > 0
    ? Math.max(0, Math.min(64, budget - W.cursor - laneW([markW, 0, agentW])))
    : 56;
  for (const task of snap.tasks) {
    const cells = [
      taskMarkPaint(task)(padTo(taskMarkText(task), markW)),
      // cutTo(s, 0) returns s unchanged, so an empty slot stays empty.
      cell(descW > 0 ? cutTo(task.description, descW, true) : '', descW),
      dim(cell(`[${cutTo(task.agent, Math.max(1, agentW - 2))}]`, agentW)),
    ];
    lines.push(`${cursor(index)}${em(on(index), cells.join(' '))}`);
    if (taskExpanded(task)) markDetail(() => {
      lines.push(kv('task:', accent(task.id)));
      lines.push(kv('agent:', task.agent));
      lines.push(kv('model:', task.model));
      lines.push(kv('status:', `${statusWord(task.status)} ${dim('· started:')} ${fmtLocal(task.startedAt)}`));
      if (task.completedAt) lines.push(kv('completed:', fmtLocal(task.completedAt)));
      lines.push(kv('elapsed:', `${task.startedAt ? fmtElapsed(task.startedAt, task.completedAt) : '?'}${task.turns !== undefined ? ` ${dim('· turns:')} ${task.turns}` : ''}${task.toolCalls !== undefined ? ` ${dim('· tool calls:')} ${task.toolCalls}` : ''}`));
      if (task.usage) {
        const label = task.status === 'completed' ? 'usage:' : 'live:';
        lines.push(kv(label, `${dim('in=')}${fmtCount(task.usage.in ?? 0)} ${dim('out=')}${fmtCount(task.usage.out ?? 0)} ${dim('cacheR=')}${fmtCount(task.usage.cacheRead ?? 0)}`));
        lines.push(kv('cost:', fmtCost(task.usage.cost ?? 0)));
      }
    });
    index++;
  }
  // Overall: per-model rows grouped by project directory. `w` toggles
  // machine-wide vs this pane's directory; past days stay machine-wide.
  const want = normProject(snap.paneProject);
  // '?' rows of the pane's own session belong to this dir too.
  let scoped = overallScope === 'dir' && want
    ? snap.overall.filter(row => normProject(row.project) === want
      || (row.project === '?' && snap.state.sessionId && row.sessions?.has(snap.state.sessionId)))
    : snap.overall;
  lines.push('');
  lines.push(`${bold('Overall today')} ${dim(overallScope === 'dir' && snap.paneProject ? `(${snap.paneProject} only)` : '(all sessions)')}`);
  if (scoped.length === 0) lines.push(`  ${dim('(none yet)')}`);
  const total = emptyAgg();
  for (const row of scoped) {
    for (const key of ['reqs', 'in', 'out', 'cacheRead', 'cacheWrite', 'cost', 'secs']) total[key] += row[key];
  }
  // Both scopes: one row per model, grouped by provider (first path
  // segment), so max-llama/unsloth/… groups under max-llama. Dir scope
  // pre-merged project spellings above; machine scope merges here.
  const merged = new Map();
  for (const row of scoped) {
    if (!merged.has(row.model)) merged.set(row.model, { model: row.model, ...emptyAgg() });
    const agg = merged.get(row.model);
    for (const key of ['reqs', 'in', 'out', 'cacheRead', 'cacheWrite', 'cost', 'secs']) agg[key] += row[key];
  }
  const byProvider = new Map();
  for (const row of merged.values()) {
    const slash = row.model.indexOf('/');
    const provider = slash >= 0 ? row.model.slice(0, slash) : '?';
    const short = slash >= 0 ? row.model.slice(slash + 1) : row.model;
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push({ ...row, short });
  }
  // Stat grid shared by Overview and History: name slot, then req=, in=,
  // out=, time=/days= and cost columns — every field on one column. The
  // name slot absorbs the slack and carries the hierarchy indent inside
  // it, so sub-rows never shift the grid. shedProfile drops in= then
  // time=/days=; req=, out= and cost always stay. req/cost columns grow
  // for wider data instead of letting it be cut at the lane edge.
  const statAggs = [...scoped, total, ...(snap.history ?? []).flatMap(b => [b, ...b.days])];
  const reqW = Math.max(W.req, ...statAggs.map(a => textWidth(`req=${a.reqs === 0 ? '?' : a.reqs}`)));
  const costW = Math.max(W.cost, ...statAggs.map(a => textWidth(`· ${fmtCost(a.cost)}`)));
  const statCells = [reqW, ...(prof.in ? [W.in] : []), W.out, ...(prof.time ? [W.meter] : []), costW];
  const nameSlot = Math.max(NAME_MIN, (budget > 0 ? budget : 78) - W.cursor - laneW(statCells) - 1);
  const statFields = (agg, meter) => [
    field('req=', agg.reqs === 0 ? '?' : String(agg.reqs), reqW),
    ...(prof.in ? [field('in=', fmtCount(agg.in), W.in)] : []),
    field('out=', fmtCount(agg.out), W.out),
    ...(prof.time ? [field(meter.label, meter.value, W.meter)] : []),
    `${dim('·')} ${fmtCost(agg.cost)}`,
  ];
  const statRow = (name, fields, opts = {}) => {
    const { gutter = '  ', sub = false, paintName = s => s, sel = false } = opts;
    const cap = Math.max(3, nameSlot - (sub ? 2 : 0));
    const nameCell = cell(`${sub ? '  ' : ''}${midEllipsis(name, cap)}`, nameSlot);
    return `${gutter}${em(sel, `${paintName(nameCell)} ${fields.join(' ')}`)}`;
  };
  for (const [provider, rows] of byProvider) {
    lines.push(`  ${bold(provider)}`);
    for (const row of rows) {
      lines.push(statRow(row.short, statFields(row, { label: 'time=', value: fmtDur(row.secs) }), { sub: true }));
    }
  }
  if (scoped.length > 1) {
    lines.push(statRow('total', statFields(total, { label: 'time=', value: fmtDur(total.secs) }), { paintName: bold }));
  }
  // History: frozen archives as yesterday / last 7d / last 30d buckets,
  // collapsed to one lane each; expand reveals the per-day rows on the
  // same grid. Buckets are selectable (enter folds). Always machine-wide
  // for the archive: old days lack project coverage for dir scope.
  lines.push('');
  lines.push(`${bold('History')} ${dim(overallScope === 'dir' && snap.paneProject ? `(${snap.paneProject} only)` : '(all sessions)')}`);
  if (!snap.history || snap.history.every(b => b.daysWithData === 0)) lines.push(`  ${dim('(none yet)')}`);
  for (const bucket of snap.history ?? []) {
    lines.push(statRow(bucket.label, statFields(bucket, { label: 'days=', value: String(bucket.daysWithData) }),
      { gutter: cursor(index), sel: on(index) }));
    if (expanded.has(`hist:${bucket.key}`)) {
      for (const day of bucket.days) {
        const label = day.project && day.project !== '?' ? `${day.day} ${day.project}` : day.day;
        lines.push(statRow(label, statFields(day, { label: 'time=', value: fmtDur(day.secs) }), { sub: true, paintName: dim }));
      }
    }
    index++;
  }
  return { text: lines.join('\n'), count: items.length, items, noFit };
}

function itemKey(item) {
  if (item.kind === 'session') return 'session';
  if (item.kind === 'request') return `req:${item.call.at}:${item.call.model}`;
  if (item.kind === 'stale') return `stale:${item.call.at}:${item.call.model}`;
  if (item.kind === 'group') return `grp:${item.group.calls[0]?.at}:${item.group.prompt}`;
  if (item.kind === 'bucket') return `hist:${item.bucket.key}`;
  return taskKey(item.task.id);
}

const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);

// Visible-width truncate that preserves ANSI colors: escape sequences
// don't advance the column, and a cut line is reset so no color bleeds.
// Walks code points so astral emoji measure exactly as in textWidth.
// Backstop only — collapsed rows are sized to fit by construction.
function fitWidth(line, cols) {
  if (cols <= 0) return line;
  let width = 0, out = '';
  for (let i = 0; i < line.length;) {
    if (line[i] === '\x1b' && line[i + 1] === '[') {
      const end = line.indexOf('m', i + 2);
      if (end === -1) break;
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i));
    const cw = charW(ch);
    if (width + cw > cols) return `${out}\x1b[0m`;
    out += ch;
    width += cw;
    i += ch.length;
  }
  return out.length === line.length ? line : `${out}\x1b[0m`;
}

// Single-line legend: marks in their row colors (it doubles as the color
// key), keys bold, glosses dim. Narrow panes shed glosses first — the
// keys are the part that must survive every width.
const LEGEND_GLOSS = 72;
const LEGEND_KEYS = 48;
function legendLine(cols) {
  const marks = `${good('✓')} ${dim('done')} ${dim('·')} ${warn('…')} ${dim('live')} ${dim('·')} ${dim('?')} ${dim('stale')}`;
  const marksBare = `${good('✓')} ${warn('…')} ${dim('?')}`;
  const keys = `${bold('j/k')} ${dim('move')} ${dim('·')} ${bold('enter')} ${dim('fold')} ${dim('·')} ${bold('w')} ${dim('scope')} ${dim('·')} ${bold('q')} ${dim('quit')}`;
  const keysBare = `${bold('j/k')} ${dim('·')} ${bold('enter')} ${dim('·')} ${bold('w')} ${dim('·')} ${bold('q')}`;
  const join = parts => parts.filter(Boolean).join(` ${dim('·')} `);
  if (!(cols > 0) || cols >= LEGEND_GLOSS) return join([marks, keys]);
  if (cols >= LEGEND_KEYS) return join([marksBare, keys]);
  return join([marksBare, keysBare]);
}

async function draw() {
  try {
    const snap = await snapshot();
    syncTaskExpansion(snap.tasks);
    const rendered = render(snap);
    let { text, noFit: keep } = rendered;
    const cols = process.stdout.columns ?? 0;
    // Right-edge guard: rows budget to exactly `cols`, but the usable lane
    // is a column narrower (pane border/padding), so an exact-fit row loses
    // its last cell (e.g. the agent tag's `]`). Cap collapsed rows at cols-1.
    if (interactive && cols > 0) text = text.split('\n').map((line, i) => (keep && keep.has(i) ? line : fitWidth(line, cols - 1))).join('\n');
    if (interactive) {
      // Pad short content so the legend sits on the viewport bottom rows
      // instead of floating mid-pane.
      const rows = process.stdout.rows ?? 0;
      if (rows > 0) {
        const contentRows = text.split('\n').length;
        const legendRows = 1;
        const pad = Math.max(0, rows - contentRows - legendRows);
        if (pad > 0) text += '\n'.repeat(pad);
      }
      // Single-line legend: two lines pushed top rows out of small panes.
      const legend = legendLine(cols);
      process.stdout.write(`\x1b[2J\x1b[3J\x1b[H${text.replaceAll('\n', '\x1b[K\r\n')}\x1b[K`);
      process.stdout.write(`\x1b[K\r\n${fitWidth(legend, cols - 1)}`);
    } else {
      process.stdout.write(`${text}\n${legendLine(cols)}\n`);
    }
    return snap;
  } catch (error) {
    process.stdout.write(`\n(viewer error: ${error.message})\n`);
    return null;
  }
}

if (!interactive) {
  await draw();
  process.exit(0);
}

let snap = await draw();
setInterval(() => {
  void draw().then(next => {
    if (next) snap = next;
  });
}, 2000);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
emitKeypressEvents(process.stdin);
function exitViewer() {
  try {
    process.stdin.setRawMode(false);
  } catch {
    // stdin may already be gone when reclaimed; exit anyway
  }
  process.stdout.write('\x1b[?25h');
  process.exit(0);
}
process.stdin.on('keypress', (_text, pressed) => {
  const key = pressed.sequence || pressed.name;
  if (key === 'q' || key === '\x03' || key === '\x04') return exitViewer();
  if (key === '\x1b[B' || key === 'j') selected++;
  if (key === '\x1b[A' || key === 'k') selected = Math.max(0, selected - 1);
  if (key === 'w') overallScope = overallScope === 'machine' ? 'dir' : 'machine';
  if (key === ' ' || key === '\r' || key === '\n') {
    const items = snap ? itemsOf(snap) : [];
    const item = items[selected];
    if (item) {
      const itemKeyValue = itemKey(item);
      if (expanded.has(itemKeyValue)) expanded.delete(itemKeyValue);
      else expanded.add(itemKeyValue);
    }
  }
  void draw().then(next => {
    if (next) snap = next;
  });
});
process.on('SIGTERM', () => exitViewer());
process.on('SIGINT', () => exitViewer());
