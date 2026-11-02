// A repository's `.env` holds its application's secrets, and Bun loads one from the working directory into any process
// it starts there. sail runs in the clone, so each way it starts itself turns that off: a key an application keeps there
// must not reach sail's environment, where it would move the agent sessions off the operator's subscription.
//
// The repository's harness is claude-code, whose preflight refuses with no credential in the environment. The `.env`
// holds one, so a process that loaded it passes the preflight, and one that didn't is refused.
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchLog, spawnRun } from '../../src/watch/spawn';
import { copyFixture, edit } from '../helpers/fixture';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const ROOT = join(import.meta.dir, '..', '..');
const BIN = join(ROOT, 'bin', 'sail');
const MAIN = join(ROOT, 'src', 'cli', 'main.ts');
const RUN = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const REFUSED = 'needs one of ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, none of which is set';

/** A repository on claude-code whose `.env` holds a key, and an environment with no credential and `bun` on its PATH. */
function dotEnvRepo(repo: TempRepo): Record<string, string> {
  const sail = copyFixture(repo.dir);
  edit(sail, 'project.yaml', 'harness: { use: fake }', 'harness: { use: claude-code }');
  writeFileSync(join(repo.dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-from-the-repository\n');
  const tools = join(repo.home, 'tools');
  mkdirSync(tools);
  symlinkSync(process.execPath, join(tools, 'bun'));
  const { ANTHROPIC_API_KEY: _key, CLAUDE_CODE_OAUTH_TOKEN: _token, ...env } = repo.env;
  return { ...env, PATH: `${tools}:/usr/bin:/bin` };
}

/** What `argv` printed, both streams, run in the repository. */
function printed(argv: string[], cwd: string, env: Record<string, string>): string {
  const child = Bun.spawnSync(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return `${child.stdout.toString()}${child.stderr.toString()}`;
}

test('plain bun loads the repository .env, so the cases below can tell', async () => {
  await withTempRepo((repo) => {
    const env = dotEnvRepo(repo);
    expect(printed([process.execPath, MAIN, 'FAKE-1', '--dry-run'], repo.dir, env)).not.toContain(REFUSED);
  });
});

test.each([
  ['bin/sail, the sail a script step finds', BIN],
  ["src/cli/main.ts through its shebang, the package's bin", MAIN],
])('%s does not load the repository .env', async (_, command) => {
  await withTempRepo((repo) => {
    const env = dotEnvRepo(repo);
    expect(printed([command, 'FAKE-1', '--dry-run'], repo.dir, env)).toContain(REFUSED);
  });
});

test('a run the watcher spawns does not load the repository .env', async () => {
  await withTempRepo(async (repo) => {
    const env = dotEnvRepo(repo);
    const runsDir = join(repo.dir, '.sail-runs');
    const spawned = spawnRun({
      root: repo.dir,
      runsDir,
      workflow: 'ticket-to-pr',
      ticketKey: 'FAKE-1',
      runId: RUN,
      env,
    });
    await spawned.exited;
    expect(readFileSync(dispatchLog(runsDir, 'ticket-to-pr', RUN), 'utf8')).toContain(REFUSED);
  });
});
