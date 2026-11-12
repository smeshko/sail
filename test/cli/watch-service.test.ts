// `sail watch --service`, `--install`, `--uninstall` and `--restart`: the watcher a login service runs and the commands
// that install it. The watcher runs in process on fake timers and a fake spawner, as in watch.test.ts; launchd is a
// recording `launchctl`, the platform is injected, and HOME and SAIL_HOME are under the test's temp directory.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type WatchDeps, watchCommand } from '../../src/cli/commands/watch';
import { EXIT_OK, EXIT_REFUSED, EXIT_RESTART } from '../../src/cli/exit-codes';
import type { Io } from '../../src/cli/index';
import type { Launchctl } from '../../src/cli/service';
import { queueDir } from '../../src/watch/queue-store';
import { readEntry, recordEntry } from '../../src/watch/registry';
import { fakeTimers } from '../helpers/fake-timers';
import { fakeInterrupts, runCaptured } from '../helpers/run-captured';
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

// --- --install and --uninstall ---

/** The deps of a login-service command: a recording launchctl, a HOME of its own, platform and uid injected. */
function agent(repo: TempRepo, extra: Partial<WatchDeps> = {}, platform = 'darwin') {
  const calls: string[][] = [];
  const launchctl: Launchctl = async (args) => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '' };
  };
  const home = join(repo.home, 'login-home');
  const deps: WatchDeps = {
    service: { platform, uid: 501, launchctl, home, sail: ['/bin/bun', '--no-env-file', '/sail/src/cli/main.ts'] },
    ...extra,
  };
  const plist = (label: string) => join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  return { deps, calls, home, plist };
}

async function sail(
  deps: WatchDeps,
  cwd: string,
  env: NonNullable<Io['env']>,
  values: Record<string, boolean | string>,
  positionals: string[] = [],
) {
  const out = io(cwd, env);
  const code = await watchCommand(deps)({ values, positionals }, out.io);
  return { code, ...out.printed };
}

test('sail watch --install a b exits 0, writes the plist with the arguments, the clone and no credential, and bootstraps it', async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    writeWatched(world.sail, 'b', { label: 'sail-b', cap: 1 });
    const a = agent(repo);
    const env = {
      ...world.env,
      LINEAR_API_KEY: 'marker-linear-0001',
      GITHUB_TOKEN: 'marker-github-0002',
      CLAUDE_CODE_OAUTH_TOKEN: 'marker-claude-0003',
    };
    const got = await sail(a.deps, repo.dir, env, { install: true }, ['a', 'b']);
    expect(got.code).toBe(EXIT_OK);
    const plist = a.plist('sail.watcher.stub');
    const text = readFileSync(plist, 'utf8');
    expect(text).toContain(
      '<string>/sail/src/cli/main.ts</string>\n    <string>watch</string>\n    <string>--service</string>\n    <string>a</string>\n    <string>b</string>\n  </array>',
    );
    expect(text).toContain(`<key>WorkingDirectory</key>\n  <string>${repo.dir}</string>`);
    for (const marker of ['marker-linear-0001', 'marker-github-0002', 'marker-claude-0003']) {
      expect(text).not.toContain(marker);
    }
    const keys = [
      ...(text
        .split('<key>EnvironmentVariables</key>')[1]
        ?.split('</dict>')[0]
        ?.matchAll(/<key>(\w+)<\/key>/g) ?? []),
    ].map((match) => match[1]);
    expect(keys).toEqual(['PATH', 'SAIL_HOME']);
    expect(a.calls).toEqual([
      ['bootout', 'gui/501/sail.watcher.stub'],
      ['bootstrap', 'gui/501', plist],
    ]);
    expect(got.stdout).toContain("sail watch: installed the login service 'sail.watcher.stub'");
    expect(got.stdout).toContain('keychain and gh auth token');
  });
}, 30_000);

test('sail watch --install with no names writes arguments ending watch, --service', async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    const a = agent(repo);
    expect((await sail(a.deps, repo.dir, world.env, { install: true })).code).toBe(EXIT_OK);
    expect(readFileSync(a.plist('sail.watcher.stub'), 'utf8')).toContain(
      '<string>watch</string>\n    <string>--service</string>\n  </array>',
    );
  });
}, 30_000);

test('sail watch --install nope exits 3 naming it and writes no plist', async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    const a = agent(repo);
    const got = await sail(a.deps, repo.dir, world.env, { install: true }, ['nope']);
    expect(got.code).toBe(EXIT_REFUSED);
    expect(got.stderr).toMatch(/^sail watch: .*'nope'/);
    expect(existsSync(a.plist('sail.watcher.stub'))).toBe(false);
    expect(a.calls).toEqual([]);
  });
}, 30_000);

test('sail watch --install while a live watcher of the repository is recorded exits 3, naming its pid', async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    mkdirSync(world.registry, { recursive: true });
    const sailDir = join(repo.dir, '.sail');
    writeFileSync(
      join(world.registry, 'stub.json'),
      JSON.stringify({
        schema: 'sail.registry.v1',
        name: 'stub',
        remote: null,
        clone: repo.dir,
        sailDir,
        updatedAt: START,
        watcher: { pid: 5151, startedAt: START, sailDir, ticketSource: 'fake', labels: ['sail-a'] },
      }),
    );
    const a = agent(repo, { isAlive: (pid) => pid === 5151 });
    const got = await sail(a.deps, repo.dir, world.env, { install: true });
    expect(got.code).toBe(EXIT_REFUSED);
    expect(got.stderr).toContain('pid 5151');
    expect(got.stderr).toContain('sail unwatch');
    expect(a.calls).toEqual([]);
  });
}, 30_000);

test('sail watch --service with a live watcher of the repository already recorded exits 3, naming its pid, and drops no command', async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    mkdirSync(world.registry, { recursive: true });
    const sailDir = join(repo.dir, '.sail');
    writeFileSync(
      join(world.registry, 'stub.json'),
      JSON.stringify({
        schema: 'sail.registry.v1',
        name: 'stub',
        remote: null,
        clone: repo.dir,
        sailDir,
        updatedAt: START,
        watcher: { pid: 5151, startedAt: START, sailDir, ticketSource: 'fake', labels: ['sail-a'] },
      }),
    );
    const got = await sail({ isAlive: (pid) => pid === 5151 }, repo.dir, world.env, { service: true }, ['a']);
    expect(got.code).toBe(EXIT_REFUSED);
    expect(got.stderr).toContain('pid 5151');
    expect(existsSync(join(repo.dir, '.sail-runs', 'watcher', 'commands'))).toBe(false);
  });
}, 30_000);

test('sail watch --install --all writes one plist for the repository that declares a watch and skips the other, saying why', async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    const other = join(repo.home, 'other');
    mkdirSync(other, { recursive: true });
    writeStub(other);
    mkdirSync(world.registry, { recursive: true });
    for (const [name, clone] of [
      ['stub', repo.dir],
      ['other', other],
    ] as const) {
      writeFileSync(
        join(world.registry, `${name}.json`),
        JSON.stringify({
          schema: 'sail.registry.v1',
          name,
          remote: null,
          clone,
          sailDir: join(clone, '.sail'),
          updatedAt: START,
        }),
      );
    }
    const a = agent(repo);
    const got = await sail(a.deps, repo.home, world.env, { install: true, all: true });
    expect(got.code).toBe(EXIT_OK);
    expect(existsSync(a.plist('sail.watcher.stub'))).toBe(true);
    expect(existsSync(a.plist('sail.watcher.other'))).toBe(false);
    expect(got.stdout).toContain("sail watch: skipped 'other': no workflow declares a watch\n");
    expect(a.calls.filter((call) => call[0] === 'bootstrap')).toHaveLength(1);
    expect(readFileSync(a.plist('sail.watcher.stub'), 'utf8')).toContain(`<string>${repo.dir}</string>`);
  });
}, 30_000);

test('sail watch --install --all exits 3 when it installs nothing: an empty registry, or every repository skipped', async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    const a = agent(repo);
    const empty = await sail(a.deps, repo.home, world.env, { install: true, all: true });
    expect(empty.code).toBe(EXIT_REFUSED);
    expect(empty.stderr).toBe('sail watch: installed no login service: no registered repository declares a watch\n');
    const other = join(repo.home, 'other');
    mkdirSync(other, { recursive: true });
    writeStub(other);
    mkdirSync(world.registry, { recursive: true });
    writeFileSync(
      join(world.registry, 'other.json'),
      JSON.stringify({
        schema: 'sail.registry.v1',
        name: 'other',
        remote: null,
        clone: other,
        sailDir: join(other, '.sail'),
        updatedAt: START,
      }),
    );
    const skipped = await sail(a.deps, repo.home, world.env, { install: true, all: true });
    expect(skipped.code).toBe(EXIT_REFUSED);
    expect(skipped.stdout).toContain("sail watch: skipped 'other': no workflow declares a watch\n");
    expect(skipped.stderr).toBe('sail watch: installed no login service: no registered repository declares a watch\n');
    expect(a.calls).toEqual([]);
  });
}, 30_000);

test('sail watch --uninstall exits 0, boots the agent out and deletes its plist; with none installed it exits 3 and launchctl sees nothing', async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    const a = agent(repo);
    const none = await sail(a.deps, repo.dir, world.env, { uninstall: true });
    expect(none.code).toBe(EXIT_REFUSED);
    expect(none.stderr).toBe(
      "sail watch: no login service is installed for 'stub': sail watch --install installs it\n",
    );
    expect(a.calls).toEqual([]);
    await sail(a.deps, repo.dir, world.env, { install: true });
    a.calls.length = 0;
    const got = await sail(a.deps, repo.dir, world.env, { uninstall: true });
    expect(got.code).toBe(EXIT_OK);
    expect(a.calls).toEqual([['bootout', 'gui/501/sail.watcher.stub']]);
    expect(existsSync(a.plist('sail.watcher.stub'))).toBe(false);
  });
}, 30_000);

test('sail watch --uninstall <name> exits 3 and leaves the installed agent, since it takes no repository', async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    const a = agent(repo);
    await sail(a.deps, repo.dir, world.env, { install: true });
    a.calls.length = 0;
    const got = await sail(a.deps, repo.dir, world.env, { uninstall: true }, ['other']);
    expect(got.code).toBe(EXIT_REFUSED);
    expect(got.stderr).toBe('sail watch: --uninstall takes no repository: sail watch --uninstall [--all]\n');
    expect(a.calls).toEqual([]);
    expect(existsSync(a.plist('sail.watcher.stub'))).toBe(true);
  });
}, 30_000);

test('sail watch --uninstall --all boots out every installed watcher agent', async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    const a = agent(repo);
    await sail(a.deps, repo.dir, world.env, { install: true });
    a.calls.length = 0;
    const got = await sail(a.deps, repo.home, world.env, { uninstall: true, all: true });
    expect(got.code).toBe(EXIT_OK);
    expect(a.calls).toEqual([['bootout', 'gui/501/sail.watcher.stub']]);
    const again = await sail(a.deps, repo.home, world.env, { uninstall: true, all: true });
    expect(again.code).toBe(EXIT_REFUSED);
    expect(again.stderr).toBe('sail watch: no login service is installed: sail watch --install installs one\n');
  });
}, 30_000);

test('on linux each of --install, --uninstall and --restart exits 3 naming macOS and writes nothing', async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    const a = agent(repo, {}, 'linux');
    for (const option of ['install', 'uninstall', 'restart']) {
      const got = await sail(a.deps, repo.dir, world.env, { [option]: true });
      expect(got.code).toBe(EXIT_REFUSED);
      expect(got.stderr).toContain('macOS');
    }
    expect(existsSync(a.home)).toBe(false);
    expect(a.calls).toEqual([]);
  });
}, 30_000);

test('sail watch --install --uninstall exits 3 with take one of --install, --uninstall and --restart', async () => {
  await withTempRepo(async (repo) => {
    const world = repository(repo);
    const got = await sail(agent(repo).deps, repo.dir, world.env, { install: true, uninstall: true });
    expect(got.code).toBe(EXIT_REFUSED);
    expect(got.stderr).toBe('sail watch: take one of --install, --uninstall and --restart\n');
  });
}, 30_000);

test('--service is accepted by the parser and --install, --uninstall and --restart are listed in no terminal watcher', async () => {
  await withTempRepo(async (repo) => {
    const help = await runCaptured(['--help'], repo.dir);
    expect(help.stdout).not.toContain('--service');
    expect(help.stdout).toContain('  sail watch --install [<workflow>...] | --install --all');
    expect(help.stdout).toContain('  sail watch --uninstall [--all]');
    const refused = await runCaptured(['watch', '--all'], repo.dir);
    expect(refused.stderr).toContain('--all goes with --install, --uninstall or --restart');
  });
}, 30_000);

// --- --restart ---

/**
 * Two installed watcher agents, `alpha` (pid 7001) and `beta` (pid 7002), each with a registry entry recording a live
 * watcher. The recording launchctl's kickstart rewrites that entry's pid to the old one + 100, standing in for launchd
 * starting the new watcher. `failing` names a label whose kickstart exits 3, and `silent` one that records nothing.
 */
async function restartWorld(repo: TempRepo, options: { failing?: string; silent?: string } = {}) {
  const sailHome = join(repo.home, 'sail-home');
  const registry = join(sailHome, 'watchers');
  const pids: Record<string, number> = { alpha: 7001, beta: 7002 };
  const calls: string[][] = [];
  const write = (name: string) =>
    recordEntry(registry, {
      schema: 'sail.registry.v1',
      name,
      remote: null,
      clone: join(repo.home, name),
      sailDir: join(repo.home, name, '.sail'),
      updatedAt: START,
      watcher: {
        pid: pids[name] ?? 0,
        startedAt: START,
        sailDir: join(repo.home, name, '.sail'),
        ticketSource: 'fake',
        labels: [name],
      },
    });
  for (const name of Object.keys(pids)) write(name);
  const launchctl: Launchctl = async (args) => {
    calls.push(args);
    if (args[0] === 'kickstart') {
      const label = args[2] ?? '';
      if (label.endsWith(`.${options.failing}`)) return { code: 3, stdout: '', stderr: 'Could not find service' };
      const name = label.slice(label.lastIndexOf('.') + 1);
      if (name !== options.silent && pids[name] !== undefined) {
        pids[name] += 100;
        write(name);
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const home = join(repo.home, 'login-home');
  const deps: WatchDeps = {
    service: { platform: 'darwin', uid: 501, launchctl, home, sail: ['/bin/bun'] },
    isAlive: () => true,
    applyTimeoutMs: 100,
    pollMs: 5,
  };
  const agents = join(home, 'Library', 'LaunchAgents');
  const install = (...names: string[]) => {
    mkdirSync(agents, { recursive: true });
    for (const name of names) writeFileSync(join(agents, `sail.watcher.${name}.plist`), '<plist/>');
  };
  return { deps, calls, install, env: { ...repo.env, SAIL_HOME: sailHome } };
}

test("sail watch --restart --all from a directory with no .sail/ kickstarts every installed watcher and prints each one's old and new pid", async () => {
  await withTempRepo(async (repo) => {
    const w = await restartWorld(repo);
    w.install('alpha', 'beta');
    const got = await sail(w.deps, repo.home, w.env, { restart: true, all: true });
    expect(got.code).toBe(EXIT_OK);
    expect(w.calls).toEqual([
      ['kickstart', '-k', 'gui/501/sail.watcher.alpha'],
      ['kickstart', '-k', 'gui/501/sail.watcher.beta'],
    ]);
    expect(got.stdout).toBe(
      "sail watch: restarted the watcher of 'alpha' (pid 7001 → 7101)\nsail watch: restarted the watcher of 'beta' (pid 7002 → 7102)\n",
    );
  });
}, 30_000);

test("sail watch --restart <name> kickstarts that repository alone, and sail watch --restart in a clone kickstarts the clone's", async () => {
  await withTempRepo(async (repo) => {
    const w = await restartWorld(repo);
    w.install('alpha', 'beta', 'stub');
    const one = await sail(w.deps, repo.home, w.env, { restart: true }, ['beta']);
    expect(one.code).toBe(EXIT_OK);
    expect(w.calls).toEqual([['kickstart', '-k', 'gui/501/sail.watcher.beta']]);
    expect(one.stdout).toBe("sail watch: restarted the watcher of 'beta' (pid 7002 → 7102)\n");
    w.calls.length = 0;
    repository(repo);
    const here = await sail(w.deps, repo.dir, w.env, { restart: true });
    expect(here.code).toBe(EXIT_OK);
    expect(w.calls).toEqual([['kickstart', '-k', 'gui/501/sail.watcher.stub']]);
  });
}, 30_000);

test('when no watcher records itself within the timeout, --restart exits 0 with the line naming the log', async () => {
  await withTempRepo(async (repo) => {
    const w = await restartWorld(repo, { silent: 'alpha' });
    w.install('alpha');
    const got = await sail(w.deps, repo.home, w.env, { restart: true }, ['alpha']);
    expect(got.code).toBe(EXIT_OK);
    expect(got.stdout).toBe(
      `sail watch: restarted the login service of 'alpha': no watcher has recorded itself yet: its log is ${join(repo.home, 'sail-home', 'services', 'sail.watcher.alpha.log')}\n`,
    );
  });
}, 30_000);

test('with no agent installed, --restart, --restart <name> and --restart --all each exit 3 naming sail watch --install, and launchctl sees nothing', async () => {
  await withTempRepo(async (repo) => {
    const w = await restartWorld(repo);
    repository(repo);
    const here = await sail(w.deps, repo.dir, w.env, { restart: true });
    const named = await sail(w.deps, repo.home, w.env, { restart: true }, ['alpha']);
    const every = await sail(w.deps, repo.home, w.env, { restart: true, all: true });
    expect([here, named, every].map(({ code, stderr }) => ({ code, stderr }))).toEqual([
      { code: 3, stderr: "sail watch: no login service is installed for 'stub': sail watch --install installs it\n" },
      { code: 3, stderr: "sail watch: no login service is installed for 'alpha': sail watch --install installs it\n" },
      { code: 3, stderr: 'sail watch: no login service is installed: sail watch --install installs one\n' },
    ]);
    expect(w.calls).toEqual([]);
  });
}, 30_000);

test("a kickstart that exits non-zero makes --restart --all exit 3 with launchctl's stderr, after trying the other agent", async () => {
  await withTempRepo(async (repo) => {
    const w = await restartWorld(repo, { failing: 'alpha' });
    w.install('alpha', 'beta');
    const got = await sail(w.deps, repo.home, w.env, { restart: true, all: true });
    expect(got.code).toBe(EXIT_REFUSED);
    expect(got.stderr).toBe('sail watch: launchctl kickstart failed (exit 3): Could not find service\n');
    expect(w.calls.map((call) => call[2])).toEqual(['gui/501/sail.watcher.alpha', 'gui/501/sail.watcher.beta']);
    expect(got.stdout).toBe("sail watch: restarted the watcher of 'beta' (pid 7002 → 7102)\n");
  });
}, 30_000);

test('sail watch --restart a b exits 3', async () => {
  await withTempRepo(async (repo) => {
    const w = await restartWorld(repo);
    w.install('alpha', 'beta');
    const got = await sail(w.deps, repo.home, w.env, { restart: true }, ['alpha', 'beta']);
    expect(got.code).toBe(EXIT_REFUSED);
    expect(got.stderr).toBe('sail watch: --restart takes one repository\n');
    expect(w.calls).toEqual([]);
  });
}, 30_000);
