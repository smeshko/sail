// What the committed golden run records of its workspace (TASK-011): the four workspace events, none keyed, and run.json's
// `workspace`, the worktree relative to the clone. The golden is regenerated from the finished engine, never by hand.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../src/events/consumers/ndjson';

const GOLDEN = join(import.meta.dir, 'fixtures', 'runs', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');

// STICKER: the golden's workspace records arrive with the regeneration in TASK-011.

test('the golden run streams its four workspace events, and none of them is keyed to a call', () => {
  const events = readEvents(GOLDEN).filter((event) => event.type.startsWith('workspace:'));
  expect({
    types: [...new Set(events.map((event) => event.type))].sort(),
    keyed: events.filter((event) => 'key' in event).length,
  }).toEqual({
    types: ['workspace:created', 'workspace:lease_released', 'workspace:leased', 'workspace:released'],
    keyed: 0,
  });
});

test("the golden run's run.json names its worktree relative to the clone, under its own run directory", () => {
  const header = JSON.parse(readFileSync(join(GOLDEN, 'run.json'), 'utf8'));
  expect(header.workspace).toBe('.sail-runs/FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N/workspace');
});
