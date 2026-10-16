import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const VIEWER = new URL('./viewer.mjs', import.meta.url);

function runViewer({ sessionId, goal }) {
  const home = mkdtempSync(join(tmpdir(), 'ledger-goal-'));
  const ledger = join(home, '.omo', 'agent', 'ledger');
  mkdirSync(ledger, { recursive: true });
  writeFileSync(join(ledger, 'state.json'), JSON.stringify({ sessionId }));
  if (goal !== null) {
    const dir = join(home, '.omo', 'agent', 'sessions', 'proj', 'extensions', 'goal');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ goal }));
  }
  const r = spawnSync('node', [VIEWER.pathname], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: home },
  });
  assert.equal(r.status, 0, `viewer exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

describe('session goal line', () => {
  it('shows an amber marker for an active goal', () => {
    const out = runViewer({
      sessionId: 'sess1234-abcd',
      goal: { status: 'active', objective: 'Ship the thing' },
    });
    assert.ok(out.includes('◉ goal:') && out.includes('Ship the thing'), out.split('\n').slice(0, 5).join('\n'));
  });

  it('turns green for an achieved goal', () => {
    const out = runViewer({
      sessionId: 'sess5678-efgh',
      goal: { status: 'complete', objective: 'Ship the thing' },
    });
    assert.ok(out.includes('✓ goal:') && out.includes('Ship the thing'), out.split('\n').slice(0, 5).join('\n'));
  });

  it('renders no goal line when there is no goal', () => {
    const out = runViewer({ sessionId: 'sess9999-xxxx', goal: null });
    assert.ok(!out.includes('goal:'), out.split('\n').slice(0, 5).join('\n'));
  });
});
