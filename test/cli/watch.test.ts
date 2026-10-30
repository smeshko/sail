// `sail watch` and `sail unwatch`, in process (DECISIONS D14, D15, D17): the refusals through run(), and the watcher
// itself on fake timers and a fake spawner, handed in through the commands' deps, with Ctrl-C through a fake
// `io.onInterrupt`. Each case has a temp repository of its own and a registry under its own SAIL_HOME.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configChecker, unwatchCommand, type WatchDeps, watchCommand } from '../../src/cli/commands/watch';
import { EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import type { Io } from '../../src/cli/index';
import { commandsDir } from '../../src/watch/inbox';
import { readEntry } from '../../src/watch/registry';
import { addCatalog, setModels } from '../helpers/catalog-harness';
import { fakeTimers } from '../helpers/fake-timers';
import { writePrWorkflow } from '../helpers/pr-workflow';
import { fakeInterrupts, runCaptured } from '../helpers/run-captured';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';
import { FAKE_PID, fakeSpawner, writeTickets, writeWatched } from '../helpers/watched';

const START = '2026-10-15T09:00:00.000Z';
/** The pid an in-process watcher records itself under: not this process's, which a second command runs in. */
const WATCHER_PID = 4242;

/** The stub with a (sail-a, cap 2), b (sail-b, cap 1) and c (sail-c, cap 1), a ticket for each, and a SAIL_HOME. */
function repository(repo: TempRepo, extra: (sail: string) => void = () => undefined) {
  const sail = writeStub(repo.dir);
  writeWatched(sail, 'a', { label: 'sail-a', cap: 2 });
  writeWatched(sail, 'b', { label: 'sail-b', cap: 1 });
  writeWatched(sail, 'c', { label: 'sail-c', cap: 1 });
  writeTickets(sail, [
    { key: 'FAKE-1', labels: ['sail-a'] },
    { key: 'FAKE-2', labels: ['sail-b'] },
    { key: 'FAKE-3', labels: ['sail-c'] },
  ]);
  extra(sail);
  const sailHome = join(repo.home, 'sail-home');
  return { sail, sailHome, env: { ...repo.env, SAIL_HOME: sailHome }, registry: join(sailHome, 'watchers') };
}

/** An Io for a command run in `cwd`, collecting what it prints. */
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

/** Writes a registry entry for `name` whose live watcher is `pid`, polling `labels` from `clone`. */
function liveEntry(registry: string, name: string, clone: string, pid: number, labels: string[]): void {
  mkdirSync(registry, { recursive: true });
  const entry = {
    schema: 'sail.registry.v1',
    name,
    remote: null,
    clone,
    sailDir: join(clone, '.sail'),
    updatedAt: START,
    watcher: { pid, startedAt: START, sailDir: join(clone, '.sail'), ticketSource: 'fake', labels },
  };
  writeFileSync(join(registry, `${name}.json`), JSON.stringify(entry));
}

/** Waits up to 5 s of real time for a command file to be dropped in `runsDir`'s inbox. */
async function commandDropped(runsDir: string): Promise<void> {
  const deadline = performance.now() + 5000;
  const dropped = () =>
    existsSync(commandsDir(runsDir)) && readdirSync(commandsDir(runsDir)).some((name) => name.endsWith('.json'));
  while (!dropped()) {
    if (performance.now() > deadline) throw new Error('no command was dropped within 5 s');
    await Bun.sleep(5);
  }
}

/** A watcher running in process from `repo` on fake timers, under WATCHER_PID, and the deps a second command needs. */
async function running(repo: TempRepo, names: string[], extra?: (sail: string) => void) {
  const world = repository(repo, extra);
  const timers = fakeTimers(START);
  const spawner = fakeSpawner(join(repo.dir, '.sail-runs'));
  const isAlive = (pid: number) => pid === WATCHER_PID || spawner.isAlive(pid);
  const deps: WatchDeps = {
    timers,
    now: timers.now,
    spawn: spawner.spawn,
    resume: spawner.resume,
    isAlive,
    pid: WATCHER_PID,
  };
  const interrupts = fakeInterrupts();
  const watcher = io(repo.dir, world.env, interrupts.onInterrupt);
  let ended = false;
  const exited = Promise.resolve(watchCommand(deps)({ values: {}, positionals: names }, watcher.io)).finally(() => {
    ended = true;
  });
  // Bounded, and never a throw: a test asserts `recorded` first.
  const deadline = performance.now() + 10_000;
  while (readEntry(world.registry, 'stub')?.watcher === undefined && !ended && performance.now() < deadline) {
    await Bun.sleep(5);
  }
  const recorded = readEntry(world.registry, 'stub')?.watcher?.pid === WATCHER_PID;
  /** Runs a second command beside the watcher, ticking the watcher once that command has dropped its file. */
  const second = async (command: typeof watchCommand, argv: string[]) => {
    const other = io(repo.dir, world.env);
    const done = command({ isAlive, pollMs: 5, applyTimeoutMs: 5000 })({ values: {}, positionals: argv }, other.io);
    await commandDropped(join(repo.dir, '.sail-runs'));
    await timers.advance(1000);
    return { code: await done, ...other.printed };
  };
  return { ...world, timers, spawner, interrupts, watcher, exited, second, recorded };
}

test('sail watch outside a git repository, without .sail/, with no names and no watched workflow, naming no workflow or an unwatched one, exits 3 saying which', async () => {
  await withTempRepo(async (repo) => {
    const outside = await runCaptured(['watch', 'a'], repo.home);
    const noSail = await runCaptured(['watch', 'a'], repo.dir);
    const { env, sail: sailDir } = repository(repo);
    const interrupts = fakeInterrupts();
    const sail = (argv: string[]) => runCaptured(argv, repo.dir, { env, onInterrupt: interrupts.onInterrupt });
    for (const name of ['a', 'b', 'c']) rmSync(join(sailDir, 'workflows', name), { recursive: true });
    const none = await sail(['watch']);
    const unknown = await sail(['watch', 'nope']);
    const unwatched = await sail(['watch', 'ticket-to-pr']);
    expect(
      [outside, noSail, none, unknown, unwatched].map(({ code, stderr }) => ({ code, stderr: stderr.split('\n')[0] })),
    ).toEqual([
      { code: EXIT_REFUSED, stderr: `sail watch: not inside a git repository: ${repo.home}` },
      { code: EXIT_REFUSED, stderr: `sail watch: no .sail/ between ${repo.dir} and the git root ${repo.dir}` },
      { code: EXIT_REFUSED, stderr: 'sail watch: no workflow declares a watch' },
      { code: EXIT_REFUSED, stderr: expect.stringMatching(/^sail watch: .*'nope'/) },
      { code: EXIT_REFUSED, stderr: "sail watch: workflow 'ticket-to-pr' isn't watched: it declares no watch" },
    ]);
    expect(existsSync(join(repo.home, 'sail-home', 'watchers'))).toBe(false);
  });
});

test('sail watch with no names starts the watcher on a, b and c and skips ticket-to-pr, which declares no watch', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, []);
    expect(w.recorded).toBe(true);
    expect(w.watcher.printed.stdout).toContain(' watch set: a, b, c\n');
    w.interrupts.interrupt();
    expect(await w.exited).toBe(EXIT_OK);
  });
}, 30_000);

test("sail watch with no names exits 3 when no workflow declares a watch, naming a workflow that won't load, and naming two that poll one label", async () => {
  await withTempRepo(async (repo) => {
    const stubOnly = writeStub(repo.dir);
    const env = { ...repo.env, SAIL_HOME: join(repo.home, 'sail-home') };
    const sail = () => runCaptured(['watch'], repo.dir, { env, onInterrupt: fakeInterrupts().onInterrupt });
    const none = await sail();
    mkdirSync(join(stubOnly, 'workflows', 'broken'), { recursive: true });
    writeFileSync(join(stubOnly, 'workflows', 'broken', 'workflow.ts'), 'export default 1;\n');
    const broken = await sail();
    rmSync(join(stubOnly, 'workflows', 'broken'), { recursive: true });
    writeWatched(stubOnly, 'a', { label: 'sail-a', cap: 1 });
    writeWatched(stubOnly, 'd', { label: 'sail-a', cap: 1 });
    const clash = await sail();
    expect([none, broken, clash].map(({ code, stderr }) => ({ code, stderr: stderr.split('\n')[0] }))).toEqual([
      { code: EXIT_REFUSED, stderr: 'sail watch: no workflow declares a watch' },
      {
        code: EXIT_REFUSED,
        stderr: expect.stringMatching(/^sail watch: .*workflows\/broken\/workflow\.ts.*default-exports no workflow/),
      },
      { code: EXIT_REFUSED, stderr: "sail watch: workflows 'a' and 'd' both poll the label 'sail-a'" },
    ]);
  });
});

test("sail watch is refused naming a model alias its harness can't run, and configChecker() follows project.yaml's edits", async () => {
  await withTempRepo(async (repo) => {
    const { sail, env } = repository(repo, (dir) => {
      addCatalog(dir);
      setModels(dir, '{ default: claude-sonnet-5, deep: { harness: cat, model: gpt-typo } }');
    });
    const interrupts = fakeInterrupts();
    const refused = await runCaptured(['watch', 'a'], repo.dir, { env, onInterrupt: interrupts.onInterrupt });
    const check = configChecker(io(repo.dir, env).io, sail);
    const answers = [await check()];
    setModels(sail, '{ default: claude-sonnet-5, deep: { harness: cat, model: gpt-ok } }');
    answers.push(await check(), await check());
    rmSync(join(sail, 'project.yaml'));
    answers.push((await check())?.replace(/: .*/, ': …'));
    expect({ code: refused.code, stderr: refused.stderr, answers }).toEqual({
      code: EXIT_REFUSED,
      stderr:
        'sail watch: .sail/project.yaml  /models/deep gpt-typo on cat (./adapters/catalog-harness.ts): no model gpt-typo\n',
      answers: [
        '.sail/project.yaml  /models/deep gpt-typo on cat (./adapters/catalog-harness.ts): no model gpt-typo',
        undefined,
        undefined,
        ".sail/project.yaml can't be read: …",
      ],
    });
    expect(existsSync(join(repo.home, 'sail-home', 'watchers'))).toBe(false);
  });
});

test('sail watch a d, where both poll one label, exits 3 naming both and the label', async () => {
  await withTempRepo(async (repo) => {
    const { env } = repository(repo, (sail) => writeWatched(sail, 'd', { label: 'sail-a', cap: 1 }));
    const { code, stderr } = await runCaptured(['watch', 'a', 'd'], repo.dir, {
      env,
      onInterrupt: fakeInterrupts().onInterrupt,
    });
    expect({ code, stderr }).toEqual({
      code: EXIT_REFUSED,
      stderr: "sail watch: workflows 'a' and 'd' both poll the label 'sail-a'\n",
    });
  });
});

test("sail watch is refused by a live watcher of this name in another clone, or of another name on one of its labels, and starts once that watcher's pid is dead", async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    const elsewhere = join(repo.home, 'elsewhere', 'stub');
    const sailWatch = async (alive: number[]) => {
      const interrupts = fakeInterrupts();
      const handle = io(repo.dir, world.env, interrupts.onInterrupt);
      const deps: WatchDeps = { timers: fakeTimers(START), isAlive: (pid) => alive.includes(pid), pid: WATCHER_PID };
      const exited = watchCommand(deps)({ values: {}, positionals: ['a'] }, handle.io);
      const ended = await Promise.race([exited, Bun.sleep(2000).then(() => 'running' as const)]);
      if (ended !== 'running') return { code: ended, stderr: handle.printed.stderr };
      interrupts.interrupt();
      return { code: await exited, stderr: handle.printed.stderr, ran: true };
    };
    liveEntry(world.registry, 'stub', elsewhere, 5151, ['sail-x']);
    const byName = await sailWatch([5151, WATCHER_PID]);
    liveEntry(world.registry, 'stub', elsewhere, 5151, ['sail-x']);
    liveEntry(world.registry, 'other', '/work/other', 6161, ['sail-a']);
    const byLabel = await sailWatch([6161, WATCHER_PID]);
    const dead = await sailWatch([WATCHER_PID]);
    expect([byName, byLabel, dead]).toEqual([
      {
        code: EXIT_REFUSED,
        stderr: `sail watch: a watcher for 'stub' already runs in ${elsewhere} (pid 5151, since ${START})\n`,
      },
      {
        code: EXIT_REFUSED,
        stderr:
          "sail watch: the label 'sail-a' on the fake ticket source is polled by the watcher of 'other' in /work/other (pid 6161)\n",
      },
      { code: EXIT_OK, stderr: '', ran: true },
    ]);
  });
}, 30_000);

test('with a watcher running, sail watch c exits 0 printing the set with c, and the watcher prints its watch set line', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, ['a', 'b']);
    expect(w.recorded).toBe(true);
    const added = await w.second(watchCommand, ['c']);
    expect(added).toEqual({
      code: EXIT_OK,
      stdout: `sail watch: the watcher of 'stub' (pid ${WATCHER_PID}) watches a, b, c\n`,
      stderr: '',
    });
    expect(w.watcher.printed.stdout).toContain(' watch set: a, b, c\n');
    const again = io(repo.dir, w.env);
    const watching = await watchCommand({ isAlive: (pid) => pid === WATCHER_PID })(
      { values: {}, positionals: ['a'] },
      again.io,
    );
    expect({ code: watching, ...again.printed }).toEqual({
      code: EXIT_OK,
      stdout: `sail watch: the watcher of 'stub' (pid ${WATCHER_PID}) watches a, b, c\n`,
      stderr: '',
    });
    w.interrupts.interrupt();
    expect(await w.exited).toBe(EXIT_OK);
  });
}, 30_000);

test('with a watcher running on a, sail watch with no names adds b and c and prints the set, and prints it again once all are watched', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, ['a']);
    expect(w.recorded).toBe(true);
    const added = await w.second(watchCommand, []);
    const set = `sail watch: the watcher of 'stub' (pid ${WATCHER_PID}) watches a, b, c\n`;
    expect(added).toEqual({ code: EXIT_OK, stdout: set, stderr: '' });
    const again = io(repo.dir, w.env);
    const code = await watchCommand({ isAlive: (pid) => pid === WATCHER_PID })(
      { values: {}, positionals: [] },
      again.io,
    );
    expect({ code, ...again.printed }).toEqual({ code: EXIT_OK, stdout: set, stderr: '' });
    w.interrupts.interrupt();
    expect(await w.exited).toBe(EXIT_OK);
  });
}, 30_000);

test("with a watcher running, sail watch of a pull-request workflow on a ticket workflow's label exits 0: labels are unique per kind (ADW-235)", async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, ['a'], (sail) => writePrWorkflow(sail, 'rv', { watch: { label: 'sail-a', cap: 1 } }));
    expect(w.recorded).toBe(true);
    const added = await w.second(watchCommand, ['rv']);
    expect(added).toEqual({
      code: EXIT_OK,
      stdout: `sail watch: the watcher of 'stub' (pid ${WATCHER_PID}) watches a, rv\n`,
      stderr: '',
    });
    w.interrupts.interrupt();
    expect(await w.exited).toBe(EXIT_OK);
  });
}, 30_000);

test("with a watcher running, sail watch of a pull-request workflow on another's label in another case exits 3: GitHub holds one label (review R1-1)", async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, ['rv'], (sail) => {
      writePrWorkflow(sail, 'rv', { watch: { label: 'sail-a', cap: 1 } });
      writePrWorkflow(sail, 'rw', { watch: { label: 'Sail-A', cap: 1 } });
    });
    expect(w.recorded).toBe(true);
    const again = io(repo.dir, w.env);
    const code = await watchCommand({ isAlive: (pid) => pid === WATCHER_PID })(
      { values: {}, positionals: ['rw'] },
      again.io,
    );
    expect({ code, ...again.printed }).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: "sail watch: workflows 'rv' and 'rw' both poll the label 'Sail-A'\n",
    });
    w.interrupts.interrupt();
    expect(await w.exited).toBe(EXIT_OK);
  });
}, 30_000);

test("with a watcher running, sail watch of a ticket workflow on another's label in another case exits 0: a ticket's label matches exactly (review R2)", async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, ['a'], (sail) => writeWatched(sail, 'd', { label: 'Sail-A', cap: 1 }));
    expect(w.recorded).toBe(true);
    const added = await w.second(watchCommand, ['d']);
    expect(added).toEqual({
      code: EXIT_OK,
      stdout: `sail watch: the watcher of 'stub' (pid ${WATCHER_PID}) watches a, d\n`,
      stderr: '',
    });
    w.interrupts.interrupt();
    expect(await w.exited).toBe(EXIT_OK);
  });
}, 30_000);

test('sail unwatch with no watcher exits 3, and sail unwatch a b with one makes it exit 0 and prints that it stops', async () => {
  await withTempRepo(async (repo) => {
    const { env } = repository(repo);
    const none = await runCaptured(['unwatch', 'a'], repo.dir, { env });
    expect({ code: none.code, stderr: none.stderr }).toEqual({
      code: EXIT_REFUSED,
      stderr: "sail unwatch: no watcher is running for 'stub' here: nothing to unwatch\n",
    });
  });
  await withTempRepo(async (repo) => {
    const w = await running(repo, ['a', 'b']);
    expect(w.recorded).toBe(true);
    const removed = await w.second(unwatchCommand, ['a', 'b']);
    expect(removed).toEqual({
      code: EXIT_OK,
      stdout: `sail unwatch: the watch set is empty: the watcher of 'stub' (pid ${WATCHER_PID}) stops\n`,
      stderr: '',
    });
    expect(await Promise.race([w.exited, Bun.sleep(2000).then(() => 'running')])).toBe(EXIT_OK);
    expect(readEntry(w.registry, 'stub')?.watcher).toBeUndefined();
  });
}, 30_000);

test('Ctrl-C ends the watcher with exit 0 and clears its registry field, and its runs are left running', async () => {
  await withTempRepo(async (repo) => {
    const w = await running(repo, ['a']);
    expect(w.recorded).toBe(true);
    await w.timers.advance(1000);
    expect(w.spawner.runs.map((run) => run.ticketKey)).toEqual(['FAKE-1']);
    w.interrupts.interrupt();
    expect(await Promise.race([w.exited, Bun.sleep(2000).then(() => 'running')])).toBe(EXIT_OK);
    expect(readEntry(w.registry, 'stub')).toMatchObject({ name: 'stub' });
    expect(readEntry(w.registry, 'stub')?.watcher).toBeUndefined();
    expect(w.spawner.isAlive(FAKE_PID)).toBe(true);
    expect(w.interrupts.unregistered).toBe(1);
  });
}, 30_000);

test('a sail watch with no terminal to stop it is refused, and writes nothing', async () => {
  await withTempRepo(async (repo) => {
    const { env } = repository(repo);
    const { code, stderr } = await runCaptured(['watch', 'a'], repo.dir, { env });
    expect({ code, stderr }).toEqual({
      code: EXIT_REFUSED,
      stderr: 'sail watch: nothing can stop it here: run it from a terminal\n',
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test("the set sail watch prints is the live watcher's, whatever a watcher that lost the registry to it wrote last (review R1-1)", async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    liveEntry(world.registry, 'stub', repo.dir, WATCHER_PID, ['sail-a']);
    const stream = join(repo.dir, '.sail-runs', 'queue', 'a');
    mkdirSync(stream, { recursive: true });
    const events = [
      { seq: 1, ts: START, type: 'watch:added', workflow: 'a', pid: 4241, label: 'sail-a' },
      { seq: 2, ts: START, type: 'watch:added', workflow: 'a', pid: WATCHER_PID, label: 'sail-a' },
      { seq: 3, ts: START, type: 'watch:removed', workflow: 'a', pid: 4241 },
    ];
    writeFileSync(join(stream, 'events.ndjson'), events.map((event) => `${JSON.stringify(event)}\n`).join(''));
    const second = io(repo.dir, world.env);
    const isAlive = (pid: number) => pid === WATCHER_PID;
    const code = await watchCommand({ isAlive, pollMs: 5, applyTimeoutMs: 50 })(
      { values: {}, positionals: ['a'] },
      second.io,
    );
    expect({ code, ...second.printed }).toEqual({
      code: EXIT_OK,
      stdout: `sail watch: the watcher of 'stub' (pid ${WATCHER_PID}) watches a\n`,
      stderr: '',
    });
    expect(existsSync(commandsDir(join(repo.dir, '.sail-runs')))).toBe(false);
  });
});
