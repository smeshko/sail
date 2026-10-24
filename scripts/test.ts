// Runs `bun test` in a child process that starts with a throwaway HOME and git identity.
// Bun reads HOME only at startup, and its spawns inherit that startup environment rather than a mutated
// process.env, so a test can't isolate itself: the environment has to be in place before Bun starts.
// test/setup.ts refuses to run tests that didn't come through here.
//
// The whole suite runs only on CI, where it is the verify check of every pull request: it takes about ten minutes
// there, and longer on a laptop. Locally a run names its files or folders, and SAIL_FULL_SUITE=1 overrides.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The `bun test` options that take their value as the next argument. */
const VALUED = new Set([
  '--timeout',
  '-t',
  '--test-name-pattern',
  '--reporter',
  '--reporter-outfile',
  '--coverage-reporter',
  '--coverage-dir',
  '--preload',
  '--rerun-each',
  '--seed',
  '--path-ignore-patterns',
  '--max-concurrency',
]);
const WHOLE = /^(\.\/?|(\.\/)?test\/?)$/;

/** Whether `args` run every test: no path narrower than test/, and no name filter. */
export function wholeSuite(args: readonly string[]): boolean {
  const paths: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? '';
    if (arg === '-t' || arg.startsWith('--test-name-pattern')) return false;
    if (arg.startsWith('-')) {
      if (VALUED.has(arg)) at++;
      continue;
    }
    paths.push(arg);
  }
  return paths.every((path) => WHOLE.test(path));
}

/** Whether the whole suite may run here: on CI, or when SAIL_FULL_SUITE=1 asks for it. */
export function fullSuiteAllowed(env: Record<string, string | undefined>): boolean {
  return (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') || env.SAIL_FULL_SUITE === '1';
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (wholeSuite(args) && !fullSuiteAllowed(process.env)) {
    console.error(
      'scripts/test.ts: the whole suite runs on CI, as the verify check of every pull request. ' +
        'Locally, run test files or folders by name (bun run test ./test/cli/port.test.ts), ' +
        'or bun run gate for the ones your branch affects. SAIL_FULL_SUITE=1 runs it here anyway.',
    );
    process.exit(2);
  }
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sail-test-home-')));

  // Git exports GIT_DIR and friends to hooks; inherited, they would point a test's git calls at the real checkout. A
  // sail script step exports SAIL_CONFIG and friends; inherited, a test's sail would read the run's project.yaml
  // instead of its temp repository's. The opt-in SAIL_LIVE* switches pass through.
  const STEP_VARIABLES = new Set(['SAIL_CONFIG', 'SAIL_EVENTS', 'SAIL_BUN']);
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
  });

  // Many tests spawn the sail CLI or git, and on a loaded machine they outrun Bun's 5 s default per test. A caller's
  // own --timeout wins. bunfig.toml can't hold this: Bun ignores a `timeout` under [test].
  const timeout = args.some((arg) => arg === '--timeout' || arg.startsWith('--timeout=')) ? [] : ['--timeout', '30000'];

  const child = Bun.spawn([process.execPath, 'test', ...timeout, ...args], {
    env,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  const code = await child.exited;
  rmSync(home, { recursive: true, force: true });
  process.exit(code);
}
