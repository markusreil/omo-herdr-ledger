// Pure aggregation/formatting for the ledger viewer (and its tests).
// No filesystem, no processes, no clocks beyond Date parsing — every
// function here is a pure function of its arguments.
export function dayName(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function emptyAgg() {
  return { reqs: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, secs: 0, cost: 0 };
}
// Seconds between request and response; null when still inflight.
export function latencySecs(call) {
  const start = new Date(call.at ?? NaN).getTime();
  const end = new Date(call.completedAt ?? NaN).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 1000;
}
export function foldAgg(agg, call) {
  agg.reqs++;
  const usage = call.usage;
  if (usage) {
    agg.in += usage.input ?? 0;
    agg.out += usage.output ?? 0;
    agg.cacheRead += usage.cacheRead ?? 0;
    agg.cacheWrite += usage.cacheWrite ?? 0;
    const cost = usage.cost;
    agg.cost += typeof cost === 'number' ? cost : (cost?.total ?? 0);
  }
  const secs = latencySecs(call);
  if (secs !== null) agg.secs += secs;
}
// Local date/time for display (`YYYY-MM-DD HH:MM:SS` in the viewer's
// timezone). Storage keys (daily files) already use local days and stay
// exactly as they are — this only changes what humans read.
export function fmtLocal(at) {
  const d = new Date(at ?? NaN);
  if (!Number.isFinite(d.getTime())) return at ?? '?';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
// Compact magnitudes, max 4 chars: 999, 1.3k, 10k, 2.5M, 5M.
export function trim1(s) {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
export function fmtCount(n) {
  n = Math.round(n);
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${trim1((n / 1000).toFixed(1))}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${trim1((n / 1000000).toFixed(1))}M`;
}
export function fmtSize(bytes) {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '?';
  if (bytes < 1000) return `${Math.round(bytes)}`;
  const scaled = bytes / 1000;
  const unit = scaled < 1000 ? 'k' : 'M';
  const value = scaled < 1000 ? scaled : scaled / 1000;
  return `${value < 10 ? trim1(value.toFixed(1)) : Math.round(value)}${unit}`;
}
// Compact durations, max 4 chars: 6.3s, 12s, 59s, 5m, 55m, 2h, 26h.
export function fmtLen(totalSecs) {
  if (!Number.isFinite(totalSecs) || totalSecs < 0) return '?';
  if (totalSecs < 10) return `${trim1(totalSecs.toFixed(1))}s`;
  if (totalSecs < 60) return `${Math.round(totalSecs)}s`;
  if (totalSecs < 3600) return `${Math.round(totalSecs / 60)}m`;
  return `${Math.round(totalSecs / 3600)}h`;
}
export function fmtDur(totalSecs) {
  return fmtLen(Math.max(0, Math.floor(totalSecs)));
}
export function fmtElapsed(startedAt, completedAt) {
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return '?';
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  return fmtLen(Math.max(0, (end - start) / 1000));
}
// Task-dir leaves carry a disambiguating hash (agent-config-b4c47ddc5774)
// while session cwds don't (agent-config) — compare hash-stripped.
export function normProject(name) {
  if (typeof name !== 'string') return null;
  return name.replace(/-[0-9a-f]{6,}$/, '');
}
export function projectLeaf(tasksDir) {
  if (typeof tasksDir !== 'string') return null;
  const parts = tasksDir.split('/').filter(Boolean);
  const i = parts.lastIndexOf('senpi-task');
  return i > 0 ? parts[i - 1] : null;
}
// One user prompt usually triggers several requests (tool results loop
// back for another turn with the same last user message). Consecutive
// completed calls sharing prompt + model collapse into one group.
export function groupCalls(completed) {
  const groups = [];
  for (const call of completed) {
    const last = groups[groups.length - 1];
    if (last && last.prompt === call.prompt && last.model === (call.model ?? '?')) {
      last.calls.push(call);
    } else {
      groups.push({ prompt: call.prompt, model: call.model ?? '?', calls: [call] });
    }
  }
  return groups;
}
// A task counts toward "today" when it ran today (started or finished
// local-day matches), is still active, or carries no dates at all.
function taskIsToday(task, todayName) {
  const status = task.status;
  if (status === 'running' || status === 'working') return true;
  const dates = [task.startedAt, task.completedAt].filter(Boolean);
  if (dates.length === 0) return true;
  return dates.some(d => dayName(new Date(d)) === todayName);
}
// Machine-wide per-model totals (all sessions, not just the pane's).
// Child tasks whose requests were hook-logged (in-process children carry the
// task id on their entries) are already counted — fold in only the rest,
// using task run_stats or the child session file.
export function overallToday(allCalls, tasks, todayName = dayName()) {
  // Tasks are all-time records: only fold in ones from today, or still
  // running (their usage is live). Dateless tasks are included — their
  // age is unknown, and excluding them would hide running work.
  // Rows keyed project/model. Hook entries carry project for new data;
  // older ones group under '?'.
  const byModel = new Map();
  const hookedTasks = new Set();
  for (const call of allCalls) {
    if (call.done !== true) continue;
    // Unscoped ('?') rows split per session: a shared '?' row would be
    // claimed whole by every window's dir filter (163 reqs counted in
    // two windows at once). Scoped rows aggregate across sessions safely.
    const project = call.project ?? '?';
    const key = project === '?' && call.sessionId
      ? `? \0 ${(call.model ?? '?')} \0 ${call.sessionId}`
      : `${project} \0 ${(call.model ?? '?')}`;
    if (!byModel.has(key)) byModel.set(key, { project, model: call.model ?? '?', sessions: new Set(), ...emptyAgg() });
    const row = byModel.get(key);
    if (call.sessionId) row.sessions.add(call.sessionId);
    foldAgg(row, call);
    if (call.taskId) hookedTasks.add(call.taskId);
  }
  for (const task of tasks) {
    if (!task.usage || !task.usageModel || hookedTasks.has(task.id)) continue;
    if (!taskIsToday(task, todayName)) continue;
    const key = `${task.project ?? '?'} \0 ${task.usageModel}`;
    if (!byModel.has(key)) byModel.set(key, { project: task.project ?? '?', model: task.usageModel, ...emptyAgg() });
    const agg = byModel.get(key);
    if (task.reqCount !== null && task.reqCount !== undefined) agg.reqs += task.reqCount;
    agg.in += task.usage.in ?? 0;
    agg.out += task.usage.out ?? 0;
    agg.cacheRead += task.usage.cacheRead ?? 0;
    agg.cacheWrite += task.usage.cacheWrite ?? 0;
    agg.cost += task.usage.cost ?? 0;
  }
  return [...byModel.values()];
}
// ── Display-width formatting ─────────────────────────────────────────────
// Terminal cells: CJK and emoji glyphs occupy two columns. Every pad and
// cut in the viewer runs through these, so collapsed lanes stay
// single-line and columns line up at any pane width. Plain text only —
// pad/cut before painting, never on strings carrying ANSI escapes.
export const MODEL_MAX = 24;
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u;
export function charW(ch) {
  return WIDE.test(ch) ? 2 : 1;
}
export function textWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charW(ch);
  return w;
}
// Truncate to a visible width (the `…` counts toward it); `word` trims
// back to the last space when the cut would split a word near its end.
export function cutTo(s, max, word = false) {
  s = String(s);
  if (textWidth(s) <= max || max < 1) return s;
  let out = '', w = 0;
  for (const ch of s) {
    const cw = charW(ch);
    if (w + cw > max - 1) break;
    out += ch; w += cw;
  }
  if (word) {
    const sp = out.lastIndexOf(' ');
    if (sp >= (out.length * 2) / 3) out = out.slice(0, sp);
  }
  return `${out}…`;
}
export function padTo(s, w) {
  return s + ' '.repeat(Math.max(0, w - textWidth(s)));
}
// Middle ellipsis: `muse-spark-1.3-contributor` -> `muse-spark-…-contributor`.
// Collapsed rows cap model slugs at MODEL_MAX this way; the full id lives
// in the expanded detail block. Below 5 columns a middle cut cannot keep
// both ends, so it falls back to a head cut.
export function midEllipsis(s, max = MODEL_MAX) {
  s = String(s ?? '?');
  if (textWidth(s) <= max) return s;
  if (max < 5) return cutTo(s, max);
  const keep = max - 1;
  const headW = Math.ceil(keep / 2), tailW = Math.floor(keep / 2);
  let head = '', w = 0;
  for (const ch of s) { const cw = charW(ch); if (w + cw > headW) break; head += ch; w += cw; }
  const rev = [...s].reverse();
  let tail = '', tw = 0;
  for (const ch of rev) { const cw = charW(ch); if (tw + cw > tailW) break; tail = ch + tail; tw += cw; }
  return `${head}…${tail}`;
}
// Ledger money: the `$` grammar token at fixed 4-decimal precision.
export function fmtCost(n) {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(4)}`;
}
// Width ladder for collapsed lanes. As the pane narrows, optional fields
// shed in one fixed order — t/s rate, task tags, in=, then time=/days= —
// while out= and cost always stay; below `pace` even the size/latency
// cells cede the lane to them. `cols <= 0` (piped or unknown) shows all.
const SHED_COLS = { tps: 90, tags: 80, in: 72, time: 56, pace: 40 };
export function shedProfile(cols) {
  const shown = key => !(cols > 0) || cols >= SHED_COLS[key];
  return { tps: shown('tps'), tags: shown('tags'), in: shown('in'), time: shown('time'), pace: shown('pace') };
}
// Historic buckets over frozen per-day aggregates (completed days only;
// today is live in Overall and never folded in). Windows roll and overlap:
// yesterday ⊂ last 7d ⊂ last 30d. Day strings compare without Date parsing
// except for the window floor, which needs day arithmetic (local days).
// Each bucket carries its day rows newest-first for the expanded fold.
function dayMinus(todayName, n) {
  const d = new Date(`${todayName}T12:00:00`);
  d.setDate(d.getDate() - n);
  return dayName(d);
}
export function historyBuckets(pastDays, todayName = dayName(), project = null) {
  const want = normProject(project);
  const inScope = row => !want || normProject(row.project) === want;
  const defs = [
    { key: 'yesterday', label: 'yesterday', since: dayMinus(todayName, 1) },
    { key: '7d', label: 'last 7d', since: dayMinus(todayName, 7) },
    { key: '30d', label: 'last 30d', since: dayMinus(todayName, 30) },
  ];
  return defs.map(({ key, label, since }) => {
    const agg = emptyAgg();
    const days = pastDays
      .filter(row => row.day < todayName && row.day >= since && row.reqs !== 0 && inScope(row))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
    for (const row of days) {
      for (const field of ['reqs', 'in', 'out', 'cacheRead', 'cacheWrite', 'cost', 'secs']) agg[field] += row[field] ?? 0;
    }
    return { key, label, days, daysWithData: new Set(days.map(row => row.day)).size, ...agg };
  });
}
