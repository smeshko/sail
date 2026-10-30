// `runsIn()` reads run directories while their runs write them: a `run.json` created but not yet written is a run not
// yet started, and an event line still being appended is left for the next read, rather than either throwing.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runsIn } from './sail-process';

const header = (runId: string) =>
  JSON.stringify({
    runId,
    workflow: { name: 'ticket-to-pr' },
    source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'watch' },
    startedAt: '2026-10-30T12:00:00.000Z',
  });

test('runsIn skips a run whose run.json is not written yet, and leaves out an event line still being appended', () => {
  const runs = mkdtempSync(join(tmpdir(), 'sail-runs-in-'));
  mkdirSync(join(runs, 'FAKE-1-starting'));
  writeFileSync(join(runs, 'FAKE-1-starting', 'run.json'), '');
  mkdirSync(join(runs, 'FAKE-1-running'));
  writeFileSync(join(runs, 'FAKE-1-running', 'run.json'), header('FAKE-1-running'));
  writeFileSync(join(runs, 'FAKE-1-running', 'events.ndjson'), '{"type":"run:start","ts":"t"}\n{"type":"call:st');
  writeFileSync(join(runs, 'FAKE-1-running.control'), 'stopped\n');
  try {
    expect(runsIn(runs).map((run) => ({ runId: run.runId, events: run.events.map((event) => event.type) }))).toEqual([
      { runId: 'FAKE-1-running', events: ['run:start'] },
    ]);
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
});
