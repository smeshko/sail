// The Claude Code process's own group (D7): spawned detached, so it leads a group with its own pid, and reaped, the
// leader's children included, before the session returns. Real processes, so the deadlines are generous.
import { afterEach, expect, test } from 'bun:test';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { createSpawner } from '../../../src/adapters/claude-code/process';

const ENV = { PATH: '/usr/bin:/bin' };
const started: number[] = [];

afterEach(() => {
  for (const pid of started.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
  }
});

/** Whether the group `pgid` still has a member: true, or the error code that says it hasn't. */
function group(pgid: number): true | string {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'unknown';
  }
}

/**
 * The group's state once it is gone, or after `ms`. macOS answers EPERM for a group whose last members are exiting or
 * not yet waited for, so only ESRCH counts as gone.
 */
async function settled(pgid: number, ms = 5_000): Promise<true | string> {
  const deadline = performance.now() + ms;
  while (group(pgid) !== 'ESRCH' && performance.now() < deadline) await Bun.sleep(25);
  return group(pgid);
}

const pidOf = (spawned: SpawnedProcess): number => {
  const { pid } = spawned as unknown as { pid?: number };
  if (pid !== undefined) started.push(pid);
  return pid ?? -1;
};

test('a spawned tree leads a group of its own, and reap leaves none of it, the background child included', async () => {
  const spawner = createSpawner();
  const spawned = spawner.spawn({
    command: '/bin/sh',
    args: ['-c', 'sleep 30 & sleep 30'],
    cwd: process.cwd(),
    env: ENV,
    signal: new AbortController().signal,
  });
  const pid = pidOf(spawned);
  await Bun.sleep(200);
  const before = group(pid);
  await spawner.reap(500);
  expect({ before, after: await settled(pid) }).toEqual({ before: true, after: 'ESRCH' });
}, 30_000);

test('a leader that exits by itself is reaped without waiting out the grace, and its child with it', async () => {
  const spawner = createSpawner();
  const spawned = spawner.spawn({
    command: '/bin/sh',
    args: ['-c', 'sleep 30 & exit 0'],
    cwd: process.cwd(),
    env: ENV,
    signal: new AbortController().signal,
  });
  const pid = pidOf(spawned);
  await new Promise((done) => spawned.once('exit', done));
  const before = group(pid);
  const at = performance.now();
  await spawner.reap(20_000);
  const took = performance.now() - at;
  expect({ before, after: await settled(pid), quick: took < 10_000 }).toEqual({
    before: true,
    after: 'ESRCH',
    quick: true,
  });
}, 30_000);

test("the SDK's signal stops the group when it aborts", async () => {
  const spawner = createSpawner();
  const controller = new AbortController();
  const pid = pidOf(
    spawner.spawn({
      command: '/bin/sh',
      args: ['-c', 'sleep 30'],
      cwd: process.cwd(),
      env: ENV,
      signal: controller.signal,
    }),
  );
  await Bun.sleep(200);
  const before = group(pid);
  controller.abort();
  expect({ before, after: await settled(pid) }).toEqual({ before: true, after: 'ESRCH' });
}, 30_000);
