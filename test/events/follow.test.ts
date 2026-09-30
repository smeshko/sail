// followEvents(): a run's events delivered from the start, then as they are appended, until the run has ended. Each case
// polls every 10 ms unless it says otherwise, and the test appends to the file and writes STATUS between polls.
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FollowOptions, followEvents } from '../../src/events/follow';
import type { SailEvent } from '../../src/events/types';
import { at, RUN_ID } from '../helpers/events';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A run directory whose STATUS holds `status`. */
function runDir(status: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-follow-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'STATUS'), status);
  return dir;
}

/** The `seq`th event: a call's start. */
const event = (seq: number): SailEvent => ({
  seq,
  ts: at(seq * 100),
  type: 'stage:start',
  runId: RUN_ID,
  key: `tests#${seq}`,
  stage: 'tests',
  call: seq,
  try: 1,
  kind: 'script',
  consumed: {},
});

/** The `seq`th event: the run's end. */
const ended = (seq: number, status: 'completed' | 'suspended'): SailEvent => ({
  seq,
  ts: at(seq * 100),
  type: 'run:end',
  runId: RUN_ID,
  status,
  ...(status === 'suspended' ? { stopReason: 'interrupted' as const, message: 'stopped during tests#1' } : {}),
  replays: 1,
});

const lines = (...events: SailEvent[]) => events.map((each) => `${JSON.stringify(each)}\n`).join('');

/** Follows `dir`, keeping the seq of each event delivered, and whether the follow has settled. */
function follow(dir: string, options: Partial<FollowOptions> = {}) {
  const seen: number[] = [];
  let settled = false;
  const done = followEvents(dir, { pollMs: 10, ...options, onEvent: (each) => seen.push(each.seq) }).finally(() => {
    settled = true;
  });
  return {
    seen,
    done,
    get settled() {
      return settled;
    },
  };
}

/** Waits until `ready()` holds, or the follow has settled, or 2 s have passed. */
async function until(following: { readonly settled: boolean }, ready: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!ready() && !following.settled && performance.now() < deadline) await Bun.sleep(5);
}

const eventsOf = (dir: string) => join(dir, 'events.ndjson');

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a finished run is delivered whole, once and in order, and the follow ends without waiting', async () => {
  const dir = runDir('completed\n');
  writeFileSync(eventsOf(dir), lines(event(1), event(2), ended(3, 'completed')));
  const controller = new AbortController();
  const following = follow(dir, { pollMs: 60_000, signal: controller.signal });
  const result = await Promise.race([following.done, Bun.sleep(1000).then(() => 'still waiting')]);
  controller.abort();
  expect([result, following.seen]).toEqual(['ended', [1, 2, 3]]);
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a running run delivers what is appended, and the follow ends once run:end comes with a finished STATUS', async () => {
  const dir = runDir('running\n');
  writeFileSync(eventsOf(dir), lines(event(1), event(2)));
  const following = follow(dir);
  await until(following, () => following.seen.length === 2);
  await Bun.sleep(50);
  const caughtUp = following.settled;
  appendFileSync(eventsOf(dir), lines(event(3), event(4)));
  await until(following, () => following.seen.length === 4);
  writeFileSync(join(dir, 'STATUS'), 'completed\n');
  appendFileSync(eventsOf(dir), lines(ended(5, 'completed')));
  expect([caughtUp, await following.done, following.seen]).toEqual([false, 'ended', [1, 2, 3, 4, 5]]);
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ("a resumed run's earlier run:end doesn't end the follow, while STATUS says running or before the last run:end", async () => {
  const dir = runDir('running\n');
  writeFileSync(eventsOf(dir), lines(event(1), event(2), ended(3, 'suspended')));
  const following = follow(dir);
  await until(following, () => following.seen.length === 3);
  await Bun.sleep(50);
  const inTheResumeWindow = following.settled;
  appendFileSync(eventsOf(dir), lines(event(4), event(5)));
  // The resumed process writes STATUS before its run:end.
  writeFileSync(join(dir, 'STATUS'), 'completed\n');
  await until(following, () => following.seen.length === 5);
  await Bun.sleep(50);
  const beforeTheLastRunEnd = following.settled;
  appendFileSync(eventsOf(dir), lines(ended(6, 'completed')));
  expect([inTheResumeWindow, beforeTheLastRunEnd, await following.done, following.seen]).toEqual([
    false,
    false,
    'ended',
    [1, 2, 3, 4, 5, 6],
  ]);
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a torn line is delivered once it is complete, and only once', async () => {
  const dir = runDir('running\n');
  const third = JSON.stringify(event(3));
  writeFileSync(eventsOf(dir), `${lines(event(1), event(2))}${third.slice(0, 30)}`);
  const following = follow(dir);
  await until(following, () => following.seen.length >= 2);
  await Bun.sleep(50);
  const whileTorn = [...following.seen];
  writeFileSync(join(dir, 'STATUS'), 'completed\n');
  appendFileSync(eventsOf(dir), `${third.slice(30)}\n${lines(ended(4, 'completed'))}`);
  expect([whileTorn, await following.done, following.seen]).toEqual([[1, 2], 'ended', [1, 2, 3, 4]]);
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a missing events file is waited for, then followed', async () => {
  const dir = runDir('running\n');
  const following = follow(dir);
  await Bun.sleep(50);
  const waited = !following.settled;
  writeFileSync(join(dir, 'STATUS'), 'completed\n');
  writeFileSync(eventsOf(dir), lines(event(1), ended(2, 'completed')));
  expect([waited, await following.done, following.seen]).toEqual([true, 'ended', [1, 2]]);
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('an abort during the wait ends the follow at once, aborted', async () => {
  const dir = runDir('running\n');
  writeFileSync(eventsOf(dir), lines(event(1)));
  const controller = new AbortController();
  const following = follow(dir, { pollMs: 10_000, signal: controller.signal });
  await until(following, () => following.seen.length === 1);
  controller.abort();
  const result = await Promise.race([following.done, Bun.sleep(1000).then(() => 'still waiting')]);
  expect([result, following.seen]).toEqual(['aborted', [1]]);
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ("a line that can't be read ends the follow with the refusal", async () => {
  const dir = runDir('running\n');
  writeFileSync(eventsOf(dir), lines(event(1)));
  const following = follow(dir);
  await until(following, () => following.seen.length === 1);
  appendFileSync(eventsOf(dir), 'not json\n');
  expect([await following.done, following.seen]).toEqual([
    { refused: expect.stringMatching(/^events\.ndjson:2 can't be read: ./) },
    [1],
  ]);
});
