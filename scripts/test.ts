// Runs `bun test` in a child process that starts with a throwaway HOME and git identity.
// Bun reads HOME only at startup, and its spawns inherit that startup environment rather than a mutated
// process.env, so a test can't isolate itself: the environment has to be in place before Bun starts.
// test/setup.ts refuses to run tests that didn't come through here.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'sail-test-home-')));

// Git exports GIT_DIR and friends to hooks; inherited, they would point a test's git calls at the real checkout.
// A script step exports SAIL_CONFIG; inherited, it would point the CLI under test at that run's config.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith('GIT_') && key !== 'SAIL_CONFIG') env[key] = value;
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

// Many tests spawn the sail CLI or git, and on a loaded machine they outrun Bun's 5 s default per test. A caller's own
// --timeout wins. bunfig.toml can't hold this: Bun ignores a `timeout` under [test].
const args = process.argv.slice(2);
const timeout = args.some((arg) => arg === '--timeout' || arg.startsWith('--timeout=')) ? [] : ['--timeout', '30000'];

const child = Bun.spawn([process.execPath, 'test', ...timeout, ...args], {
  env,
  stdio: ['inherit', 'inherit', 'inherit'],
});
const code = await child.exited;
rmSync(home, { recursive: true, force: true });
process.exit(code);
