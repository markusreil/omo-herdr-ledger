import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  charW, cutTo, emptyAgg, foldAgg, fmtCost, fmtCount, fmtSize, fmtLen, groupCalls,
  historyBuckets, midEllipsis, MODEL_MAX, normProject, overallToday, padTo,
  projectLeaf, shedProfile, textWidth,
} from './stats.mjs';

const call = (over = {}) => ({
  at: '2026-10-13T10:01:00.000Z',
  sessionId: 's1',
  model: 'opencode-go/m-a',
  payloadBytes: 1000,
  done: true,
  completedAt: '2026-10-13T10:01:02.000Z',
  status: 200,
  prompt: 'do the thing',
  usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, cost: { total: 0.001 } },
  ...over,
});

describe('fmtCount', () => {
  it('renders magnitudes in max 4 chars', () => {
    assert.equal(fmtCount(0), '0');
    assert.equal(fmtCount(999), '999');
    assert.equal(fmtCount(1350), '1.4k');
    assert.equal(fmtCount(5000), '5k');
    assert.equal(fmtCount(10319), '10k');
    assert.equal(fmtCount(2500000), '2.5M');
    assert.equal(fmtCount(5000000), '5M');
  });
});

describe('fmtSize', () => {
  it('scales bytes without unit confusion', () => {
    assert.equal(fmtSize(978), '978');
    assert.equal(fmtSize(1350), '1.4k');
    assert.equal(fmtSize(852217), '852k');
    assert.equal(fmtSize(22000000), '22M');
    assert.equal(fmtSize(undefined), '?');
  });
});

describe('fmtLen', () => {
  it('stays within 4 chars', () => {
    assert.equal(fmtLen(6.3), '6.3s');
    assert.equal(fmtLen(12), '12s');
    assert.equal(fmtLen(59), '59s');
    assert.equal(fmtLen(72), '1m');
    assert.equal(fmtLen(3300), '55m');
    assert.equal(fmtLen(7800), '2h');
    assert.equal(fmtLen(NaN), '?');
  });
  it('every output fits 4 chars over a sweep', () => {
    for (const secs of [0, 1, 9.9, 10, 59.9, 60, 600, 3599, 3600, 86399]) {
      assert.ok(fmtLen(secs).length <= 4, `${secs} -> ${fmtLen(secs)}`);
    }
  });
});

describe('foldAgg', () => {
  it('sums usage, cost and latency', () => {
    const agg = emptyAgg();
    foldAgg(agg, call());
    foldAgg(agg, call({ usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.002 } }));
    assert.equal(agg.reqs, 2);
    assert.equal(agg.in, 150);
    assert.equal(agg.out, 25);
    assert.equal(agg.cacheRead, 300);
    assert.equal(agg.cost, 0.003);
    assert.equal(agg.secs, 4);
  });
  it('tolerates missing usage and numeric cost', () => {
    const agg = emptyAgg();
    foldAgg(agg, call({ usage: null }));
    foldAgg(agg, call({ usage: { input: 1, output: 2, cost: 0.5 } }));
    assert.equal(agg.reqs, 2);
    assert.equal(agg.cost, 0.5);
  });
  it('ignores inflight latency', () => {
    const agg = emptyAgg();
    foldAgg(agg, call({ done: false, completedAt: null }));
    assert.equal(agg.reqs, 1);
    assert.equal(agg.secs, 0);
  });
});

describe('groupCalls', () => {
  it('merges consecutive same-prompt same-model calls', () => {
    const groups = groupCalls([call(), call(), call({ prompt: 'other' }), call({ prompt: 'do the thing' })]);
    assert.equal(groups.length, 3);
    assert.equal(groups[0].calls.length, 2);
    assert.equal(groups[1].calls.length, 1);
    assert.equal(groups[2].calls.length, 1);
  });
  it('splits on model change but merges consecutive null prompts', () => {
    const groups = groupCalls([call(), call({ model: 'm-b' }), call({ prompt: null }), call({ prompt: null })]);
    assert.equal(groups.length, 3);
    assert.equal(groups[2].calls.length, 2);
  });
});

describe('historyBuckets', () => {
  const day = (day, reqs) => ({ day, reqs, in: reqs * 10, out: reqs, cacheRead: 0, cacheWrite: 0, secs: 1, cost: 0.01 });
  it('buckets yesterday / 7d / 30d from frozen days only', () => {
    const buckets = historyBuckets([day('2026-10-12', 10), day('2026-10-13', 20), day('2026-10-14', 30)], '2026-10-15');
    assert.equal(buckets[0].reqs, 30);
    assert.equal(buckets[0].daysWithData, 1);
    assert.equal(buckets[1].reqs, 60);
    assert.equal(buckets[1].daysWithData, 3);
    assert.equal(buckets[2].reqs, 60);
    assert.deepEqual(buckets[1].days.map(d => d.day), ['2026-10-14', '2026-10-13', '2026-10-12']);
  });
  it('filters by project when scoped, dropping unattributed rows', () => {
    const d = (day, project, reqs) => ({ day, project, reqs, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, secs: 0, cost: 0 });
    const rows = [d('2026-10-14', 'agent-config', 5), d('2026-10-14', '?', 7), d('2026-10-14', 'other-b4c47ddc', 9)];
    const buckets = historyBuckets(rows, '2026-10-15', 'agent-config');
    assert.equal(buckets[0].reqs, 5);
    assert.equal(buckets[0].daysWithData, 1);
    assert.equal(historyBuckets(rows, '2026-10-15')[0].reqs, 21);
  });
  it('excludes today and zero-req days', () => {
    const buckets = historyBuckets([day('2026-10-15', 99), day('2026-10-13', 0)], '2026-10-15');
    assert.ok(buckets.every(b => b.reqs === 0 && b.daysWithData === 0));
  });
});

describe('textWidth / cutTo / padTo', () => {
  it('counts CJK and emoji glyphs as two columns', () => {
    assert.equal(textWidth('abc'), 3);
    assert.equal(textWidth('日本語'), 6);
    assert.equal(textWidth('ok🚀'), 4);
    assert.equal(charW('🚀'), 2);
    assert.equal(charW('a'), 1);
  });
  it('truncates to a visible width with the ellipsis counted', () => {
    assert.equal(cutTo('hello world', 20), 'hello world');
    assert.equal(cutTo('hello world', 7), 'hello …');
    assert.equal(cutTo('hello world', 7, true), 'hello…');
    assert.equal(cutTo('日本語です', 5), '日本…');
  });
  it('pads on visible width, never shorter', () => {
    assert.equal(padTo('ab', 5), 'ab   ');
    assert.equal(padTo('日本', 5), '日本 ');
    assert.equal(padTo('longer', 3), 'longer');
  });
});

describe('midEllipsis', () => {
  it('caps model slugs in the middle, keeping head and tail', () => {
    assert.equal(midEllipsis('muse-spark-1.3-contributor', 24), 'muse-spark-1…contributor');
    assert.equal(midEllipsis('gpt-5.6-sol'), 'gpt-5.6-sol');
  });
  it('falls back to a head cut below 5 columns', () => {
    assert.equal(midEllipsis('yesterday', 3), 'ye…');
    assert.equal(midEllipsis('abcd', 2), 'a…');
    assert.ok(textWidth(midEllipsis('yesterday', 3)) <= 3);
  });
  it('honors the default MODEL_MAX cap over a sweep', () => {
    for (const s of ['a', 'opencode-go/' + 'x'.repeat(40), '日本語'.repeat(30)]) {
      assert.ok(textWidth(midEllipsis(s)) <= MODEL_MAX, `${s} -> ${midEllipsis(s)}`);
    }
  });
});

describe('fmtCost', () => {
  it('renders the $ token at fixed 4-decimal precision', () => {
    assert.equal(fmtCost(0.0123), '$0.0123');
    assert.equal(fmtCost(0), '$0.0000');
    assert.equal(fmtCost(12.5), '$12.5000');
    assert.equal(fmtCost(NaN), '$0.0000');
  });
});

describe('shedProfile', () => {
  const order = ['tps', 'tags', 'in', 'time', 'pace'];
  const shownAt = cols => order.filter(key => shedProfile(cols)[key]);
  it('shows every field when the width is unknown', () => {
    assert.deepEqual(shownAt(0), order);
    assert.deepEqual(shownAt(-1), order);
  });
  it('sheds t/s, task tags, in=, time=/days= in that order', () => {
    assert.deepEqual(shownAt(200), ['tps', 'tags', 'in', 'time', 'pace']);
    assert.deepEqual(shownAt(89), ['tags', 'in', 'time', 'pace']);
    assert.deepEqual(shownAt(79), ['in', 'time', 'pace']);
    assert.deepEqual(shownAt(71), ['time', 'pace']);
    assert.deepEqual(shownAt(55), ['pace']);
    assert.deepEqual(shownAt(39), []);
  });
  it('only ever sheds the next field as the pane narrows', () => {
    let prev = shownAt(200);
    for (let cols = 199; cols >= 20; cols--) {
      const now = shownAt(cols);
      assert.ok(now.length <= prev.length, `${cols}: grew`);
      // What survives is always the tail of the shed order: one fixed
      // sequence, dropping from the front.
      assert.deepEqual(now, order.slice(order.length - now.length), `${cols}: out of order`);
      prev = now;
    }
    assert.deepEqual(prev, []);
  });
});

describe('normProject / projectLeaf', () => {
  it('strips hash suffixes for comparison', () => {
    assert.equal(normProject('agent-config-b4c47ddc5774'), 'agent-config');
    assert.equal(normProject('agent-config'), 'agent-config');
    assert.equal(normProject(null), null);
  });
  it('reads the project leaf above senpi-task', () => {
    assert.equal(projectLeaf('/x/projects/myproj-abc123/senpi-task/tasks'), 'myproj-abc123');
    assert.equal(projectLeaf(null), null);
  });
});

describe('overallToday', () => {
  const task = (over = {}) => ({
    id: 'st_1', usage: { in: 1000, out: 100, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    usageModel: 'opencode-go/m-b', reqCount: 7, ...over,
  });
  it('aggregates hooked calls per project/model', () => {
    const rows = overallToday([call(), call({ project: 'p2', sessionId: 's9' })], []);
    assert.equal(rows.length, 2);
    assert.equal(rows.find(r => r.project === 'p2').reqs, 1);
  });
  it('splits unscoped rows per session', () => {
    const rows = overallToday(
      [call({ project: undefined, sessionId: 's1' }), call({ project: undefined, sessionId: 's2' })], []);
    assert.equal(rows.length, 2);
    assert.deepEqual([...rows[0].sessions], ['s1']);
  });
  it('folds unhooked tasks and dedupes hooked ones', () => {
    const hooked = call({ taskId: 'st_1' });
    const rows = overallToday([hooked], [task({ id: 'st_1', project: 'p1' })]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reqs, 1);
    const rows2 = overallToday([], [task({ id: 'st_2', project: 'p1' })]);
    assert.equal(rows2[0].reqs, 7);
    assert.equal(rows2[0].in, 1000);
  });
  it('skips inflight calls', () => {
    const rows = overallToday([call({ done: false })], []);
    assert.equal(rows.length, 0);
  });
  it('excludes tasks from previous days', () => {
    const old = task({ id: 'st_old', project: 'p1', startedAt: '2026-10-09T05:00:00.000Z', completedAt: '2026-10-09T05:01:00.000Z', status: 'completed' });
    assert.equal(overallToday([], [old], '2026-10-14').length, 0);
    assert.equal(overallToday([], [old], '2026-10-09').length, 1);
    const running = task({ id: 'st_run', project: 'p1', startedAt: '2026-10-09T19:01:30.146Z', status: 'running' });
    assert.equal(overallToday([], [running], '2026-10-14').length, 1);
  });
});
