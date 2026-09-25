// Runs `bun test` in a child process that starts with a throwaway HOME and git identity.
// Bun reads HOME only at startup, and its spawns inherit that startup environment rather than a mutated
// process.env, so a test can't isolate itself: the environment has to be in place before Bun starts.
// test/setup.ts refuses to run tests that didn't come through here.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'sail-test-home-')));

// Git exports GIT_DIR and friends to hooks; inherited, they would point a test's git calls at the real checkout.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
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

const child = Bun.spawn([process.execPath, 'test', ...process.argv.slice(2)], {
  env,
  stdio: ['inherit', 'inherit', 'inherit'],
});
const code = await child.exited;
rmSync(home, { recursive: true, force: true });
process.exit(code);
