// Runs `bun test` in a child process that starts with a throwaway HOME and git identity.
// Bun reads HOME only at startup, and its spawns inherit that startup environment rather than a mutated
// process.env, so a test can't isolate itself: the environment has to be in place before Bun starts.
// test/setup.ts refuses to run tests that didn't come through here.
//
// The whole suite runs only on CI, where it is the verify check of every pull request: it takes about ten minutes
// there, and longer on a laptop. Locally a run names its files or folders, and SAIL_FULL_SUITE=1 overrides.
//
// Inside a sail run (RUN_ID set), a broad run (see broadRun) takes the machine's gate lock first, the one validate holds
// while its gate runs: one broad run goes at a time, so several runs' test files don't overload the machine. It waits up
// to SAIL_TEST_LOCK_SECONDS (180) and then stops with exit 2. Validate's own gate is let through: it names its pid in
// SAIL_GATE_LOCK_HOLDER, or is an ancestor of this process.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { broadRun, fullSuiteAllowed, wholeSuite } from './full-suite';

const args = process.argv.slice(2);
if (wholeSuite(args) && !fullSuiteAllowed(process.env)) {
  console.error(
    'scripts/test.ts: the whole suite runs on CI, as the verify check of every pull request. ' +
      'Locally, run test files or folders by name (bun run test ./test/cli/port.test.ts), ' +
      'or bun run gate for the ones your branch affects. SAIL_FULL_SUITE=1 runs it here anyway.',
  );
  process.exit(2);
}

interface GateLock {
  HOLDER_ENV: string;
  holder(): { pid: number; dir: string } | undefined;
  heldBy(pid: number): boolean;
  lock(options: { label: string; waiting: (dir: string) => string; seconds?: number }): Promise<boolean>;
}

/** Whether `pid` is this process's ancestor, within 10 levels: `ps` names each parent, and one that fails ends the walk. */
function isAncestor(pid: number): boolean {
  let at = process.pid;
  for (let level = 0; level < 10 && at > 1; level++) {
    const ps = Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(at)]);
    if (ps.exitCode !== 0) return false;
    at = Number(ps.stdout.toString().trim());
    if (at === pid) return true;
  }
  return false;
}

if (process.env.RUN_ID && broadRun(args)) {
  const gate = (await import(join(import.meta.dir, '..', '.sail', 'lib', 'gate-lock.mjs'))) as GateLock;
  const held = gate.holder()?.pid;
  const mine = gate.heldBy(Number(process.env[gate.HOLDER_ENV])) || (held !== undefined && isAncestor(held));
  const seconds = Number(process.env.SAIL_TEST_LOCK_SECONDS ?? 180);
  if (!mine) {
    const taken = await gate.lock({
      label: 'scripts/test.ts',
      waiting: (dir) => `waiting up to ${seconds} s for the gate in ${dir}, which holds the machine's test lock`,
      seconds,
    });
    if (!taken) {
      console.error(
        `scripts/test.ts: another run's gate holds the machine's test lock (${gate.holder()?.dir ?? 'another workspace'}), ` +
          `so this run stopped after ${seconds} s. Run the test files you changed by name, 5 or fewer at a time; ` +
          'validation runs the gate after you.',
      );
      process.exit(2);
    }
  }
}

const home = realpathSync(mkdtempSync(join(tmpdir(), 'sail-test-home-')));

// Git exports GIT_DIR and friends to hooks; inherited, they would point a test's git calls at the real checkout. A
// sail script step exports SAIL_CONFIG and friends; inherited, a test's sail would read the run's project.yaml
// instead of its temp repository's, and a test's claim would comment with the run's RUN_ID. The opt-in SAIL_LIVE*
// switches pass through.
const STEP_VARIABLES = new Set(['SAIL_CONFIG', 'SAIL_EVENTS', 'SAIL_BUN', 'RUN_ID', 'SAIL_GATE_LOCK_HOLDER']);
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith('GIT_') && !STEP_VARIABLES.has(key)) env[key] = value;
}
Object.assign(env, {
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'sail test',
  GIT_AUTHOR_EMAIL: 'test@sail.invalid',
  GIT_COMMITTER_NAME: 'sail test',
  GIT_COMMITTER_EMAIL: 'test@sail.invalid',
  SAIL_TEST_HOME: home,
  SAIL_KEEP_AWAKE: 'off',
});

const given = (option: string) => args.some((arg) => arg === option || arg.startsWith(`${option}=`));

// Many tests spawn the sail CLI or git, and on a loaded machine they outrun Bun's 5 s default per test. A caller's
// own --timeout wins. bunfig.toml can't hold this: Bun ignores a `timeout` under [test].
const timeout = given('--timeout') ? [] : ['--timeout', '60000'];

// The files run in parallel, a worker per core, and most of a test's time is the processes it waits on. Each run
// records how long each file took in the repository's common git directory, shared by its worktrees, and the next
// starts the slowest first. A caller's own --parallel wins: --parallel=1 runs the files one at a time.
const parallel = given('--parallel') ? [] : [`--parallel=${availableParallelism()}`, ...timings()];

/** The options that read and update the per-file timings, or none outside a git checkout. */
function timings(): string[] {
  const common = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? '' },
  });
  if (common.exitCode !== 0) return [];
  return [`--timings=${join(common.stdout.toString().trim(), 'sail-test-timings.json')}`, '--update-timings'];
}

const child = Bun.spawn([process.execPath, 'test', ...timeout, ...parallel, ...args], {
  env,
  stdio: ['inherit', 'inherit', 'inherit'],
});
const code = await child.exited;
rmSync(home, { recursive: true, force: true });
process.exit(code);
