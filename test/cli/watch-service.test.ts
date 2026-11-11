// `sail watch --service`, `--install`, `--uninstall` and `--restart`: the watcher a login service runs and the commands
// that install it. The watcher runs in process on fake timers and a fake spawner, as in watch.test.ts; launchd is a
// recording `launchctl`, the platform is injected, and HOME and SAIL_HOME are under the test's temp directory.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type WatchDeps, watchCommand } from '../../src/cli/commands/watch';
import { EXIT_OK, EXIT_RESTART } from '../../src/cli/exit-codes';
import type { Io } from '../../src/cli/index';
import { queueDir } from '../../src/watch/queue-store';
import { readEntry } from '../../src/watch/registry';
import { fakeTimers } from '../helpers/fake-timers';
import { fakeInterrupts } from '../helpers/run-captured';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';
import { FAKE_PID, fakeSpawner, writeTickets, writeWatched } from '../helpers/watched';

const START = '2026-10-15T09:00:00.000Z';
const WATCHER_PID = 4242;
const SECOND_PID = 4343;

function repository(repo: TempRepo) {
  const sail = writeStub(repo.dir);
  writeWatched(sail, 'a', { label: 'sail-a', cap: 2 });
  writeTickets(sail, [{ key: 'FAKE-1', labels: ['sail-a'] }]);
  const sailHome = join(repo.home, 'sail-home');
  return { sail, sailHome, env: { ...repo.env, SAIL_HOME: sailHome }, registry: join(sailHome, 'watchers') };
}

function io(cwd: string, env: NonNullable<Io['env']>, onInterrupt?: Io['onInterrupt']) {
  const printed = { stdout: '', stderr: '' };
  const handle: Io = {
    cwd,
    env,
    stdout: (text) => {
      printed.stdout += text;
    },
    stderr: (text) => {
      printed.stderr += text;
    },
    ...(onInterrupt === undefined ? {} : { onInterrupt }),
  };
  return { io: handle, printed };
}

/** A watcher running in process whose sail version answers `version.current`, started with or without `--service`. */
async function serviceWatcher(repo: TempRepo, service: boolean) {
  const world = repository(repo);
  const timers = fakeTimers(START);
  const spawner = fakeSpawner(join(repo.dir, '.sail-runs'));
  const isAlive = (pid: number) => pid === WATCHER_PID || spawner.isAlive(pid);
  const version = { current: 'aaaaaaa1111' };
  const deps: WatchDeps = {
    timers,
    now: timers.now,
    spawn: spawner.spawn,
    resume: spawner.resume,
    isAlive,
    pid: WATCHER_PID,
    sailVersion: () => version.current,
    sailVersionEveryMs: 60_000,
  };
  const interrupts = fakeInterrupts();
  const watcher = io(repo.dir, world.env, interrupts.onInterrupt);
  let ended = false;
  const exited = Promise.resolve(
    watchCommand(deps)({ values: service ? { service: true } : {}, positionals: ['a'] }, watcher.io),
  ).finally(() => {
    ended = true;
  });
  const deadline = performance.now() + 10_000;
  while (readEntry(world.registry, 'stub')?.watcher === undefined && !ended && performance.now() < deadline) {
    await Bun.sleep(5);
  }
  return { ...world, timers, spawner, interrupts, watcher, exited, version, isAlive };
}

const outcome = (exited: Promise<number>) => Promise.race([exited, Bun.sleep(3000).then(() => 'running' as const)]);

test('a watcher under --service exits 6 once its sail version changes, printing the line, and its registry field is cleared', async () => {
  await withTempRepo(async (repo) => {
    const w = await serviceWatcher(repo, true);
    await w.timers.advance(1000);
    await w.timers.advance(60_000);
    expect(await outcome(w.exited)).toBe('running');
    w.version.current = 'bbbbbbb2222';
    await w.timers.advance(60_000);
    expect(await outcome(w.exited)).toBe(EXIT_RESTART);
    expect(w.watcher.printed.stdout).toContain('sail watch: sail changed (aaaaaaa → bbbbbbb)');
    expect(readEntry(w.registry, 'stub')?.watcher).toBeUndefined();
  });
}, 30_000);

test('the run a --service watcher dispatched is still alive after it exits 6, and the next watcher adopts it', async () => {
  await withTempRepo(async (repo) => {
    const w = await serviceWatcher(repo, true);
    await w.timers.advance(1000);
    const [run] = w.spawner.runs;
    expect(run?.pid).toBe(FAKE_PID);
    w.version.current = 'bbbbbbb2222';
    await w.timers.advance(60_000);
    expect(await outcome(w.exited)).toBe(EXIT_RESTART);
    expect(w.spawner.isAlive(FAKE_PID)).toBe(true);

    mkdirSync(join(repo.dir, '.sail-runs', run?.runId ?? ''), { recursive: true });
    const timers = fakeTimers(START);
    const interrupts = fakeInterrupts();
    const second = io(repo.dir, w.env, interrupts.onInterrupt);
    const exited = Promise.resolve(
      watchCommand({
        timers,
        now: timers.now,
        spawn: w.spawner.spawn,
        resume: w.spawner.resume,
        isAlive: (pid) => pid === SECOND_PID || w.spawner.isAlive(pid),
        pid: SECOND_PID,
      })({ values: {}, positionals: ['a'] }, second.io),
    );
    const deadline = performance.now() + 10_000;
    while (readEntry(w.registry, 'stub')?.watcher?.pid !== SECOND_PID && performance.now() < deadline)
      await Bun.sleep(5);
    await timers.advance(1000);
    const events = readFileSync(join(queueDir(join(repo.dir, '.sail-runs'), 'a'), 'events.ndjson'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { type: string; run?: string; pid?: number });
    expect(events.filter((event) => event.type === 'run:adopted')).toMatchObject([{ run: run?.runId, pid: FAKE_PID }]);
    expect(w.spawner.runs).toHaveLength(1);
    interrupts.interrupt();
    expect(await outcome(exited)).toBe(EXIT_OK);
  });
}, 30_000);

test('a terminal watcher started without --service keeps running through a sail change and exits 0 only on its interrupt', async () => {
  await withTempRepo(async (repo) => {
    const w = await serviceWatcher(repo, false);
    await w.timers.advance(1000);
    w.version.current = 'bbbbbbb2222';
    await w.timers.advance(180_000);
    expect(await outcome(w.exited)).toBe('running');
    expect(w.watcher.printed.stdout).not.toContain('sail changed');
    w.interrupts.interrupt();
    expect(await outcome(w.exited)).toBe(EXIT_OK);
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(true);
  });
}, 30_000);
