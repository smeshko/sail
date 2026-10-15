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

// Review R1-2: the CLI starts each Bash command's shell detached, in a group of its own, which the leader's group never
// holds. The spawner looks up the leader's descendants while it runs, and stops each group it saw them in.

/** A leader that starts a detached shell, as the CLI's Bash tool does, says its pid, then lives `lifeMs`. */
const LEADER = (lifeMs: number) =>
  [
    "const shell = require('node:child_process').spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30'],",
    "  { detached: true, stdio: 'ignore' });",
    'console.log(shell.pid);',
    `setTimeout(() => process.exit(0), ${lifeMs});`,
  ].join('\n');

/** Spawns `LEADER` through `spawner`, and resolves with the leader's pid and its shell's once the shell has started. */
async function leaderWithShell(spawner: ReturnType<typeof createSpawner>, lifeMs: number, signal: AbortSignal) {
  const spawned = spawner.spawn({
    command: process.execPath,
    args: ['-e', LEADER(lifeMs)],
    cwd: process.cwd(),
    env: ENV,
    signal,
  });
  const pid = pidOf(spawned);
  const said = await new Promise<string>((done) =>
    (spawned.stdout as NodeJS.ReadableStream).once('data', (chunk) => done(String(chunk))),
  );
  const shell = Number(said.trim());
  started.push(shell);
  return { pid, shell };
}

test("reap stops a detached shell's group the leader started, and the job it left in the background", async () => {
  const spawner = createSpawner({ trackMs: 50 });
  const { pid, shell } = await leaderWithShell(spawner, 30_000, new AbortController().signal);
  await Bun.sleep(300);
  const before = group(shell);
  await spawner.reap(500);
  expect({ before, leader: await settled(pid), shell: await settled(shell) }).toEqual({
    before: true,
    leader: 'ESRCH',
    shell: 'ESRCH',
  });
}, 30_000);

test('a detached shell seen while the leader ran is stopped after the leader has exited by itself', async () => {
  const spawner = createSpawner({ trackMs: 50 });
  const { pid, shell } = await leaderWithShell(spawner, 400, new AbortController().signal);
  await settled(pid);
  const before = group(shell);
  await spawner.reap(500);
  expect({ before, shell: await settled(shell) }).toEqual({ before: true, shell: 'ESRCH' });
}, 30_000);

test("the SDK's abort stops the leader's detached shells with its group", async () => {
  const spawner = createSpawner({ trackMs: 60_000 });
  const controller = new AbortController();
  const { shell } = await leaderWithShell(spawner, 30_000, controller.signal);
  await Bun.sleep(200);
  const before = group(shell);
  controller.abort();
  expect({ before, shell: await settled(shell) }).toEqual({ before: true, shell: 'ESRCH' });
  await spawner.reap(500);
}, 30_000);
