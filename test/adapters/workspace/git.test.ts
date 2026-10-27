// The git plumbing the Workspace adapters share (D7): every call is non-interactive, a call that can't run or runs too
// long is a failed result rather than a throw, and a remote's URL loses its credentials before anything keys or logs
// it.
import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffWorkingTree,
  fetchRemote,
  gitSync,
  nonInteractive,
  removeWorktree,
  stripUserinfo,
} from '../../../src/adapters/workspace/git';
import { messageOf, portFailure } from '../../helpers/ports';
import { withTempRepo } from '../../helpers/temp-repo';

test("git never asks: no terminal prompt, no askpass, no credential manager dialog, the caller's ssh kept, and none of a hook's repository variables, but the user's own -c config (review #2.1)", () => {
  const never = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never' };
  const plain = nonInteractive({ HOME: '/home/sail' });
  const own = nonInteractive({
    HOME: '/home/sail',
    GIT_SSH_COMMAND: 'ssh -i key',
    GIT_SSH: '/usr/local/bin/plink',
    GIT_TERMINAL_PROMPT: '1',
    GIT_ASKPASS: '/usr/local/bin/askpass',
    SSH_ASKPASS: '/usr/local/bin/askpass',
    SSH_ASKPASS_REQUIRE: 'force',
  });
  const hooked = nonInteractive({
    HOME: '/home/sail',
    GIT_DIR: '/clone/.git',
    GIT_WORK_TREE: '/clone',
    GIT_INDEX_FILE: '/clone/.git/index',
    GIT_COMMON_DIR: '/clone/.git',
    GIT_OBJECT_DIRECTORY: '/clone/.git/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/objects',
    GIT_PREFIX: 'src/',
  });
  // The user's own `-c` config, which git keeps when it enters another repository too.
  const configured = nonInteractive({
    HOME: '/home/sail',
    GIT_CONFIG_PARAMETERS: "'safe.directory'='*'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'url.https://mirror/.insteadOf',
    GIT_CONFIG_VALUE_0: 'https://origin/',
  });
  expect({ plain, own, hooked, configured }).toEqual({
    plain: { HOME: '/home/sail', ...never },
    own: {
      HOME: '/home/sail',
      GIT_SSH_COMMAND: 'ssh -i key',
      GIT_SSH: '/usr/local/bin/plink',
      SSH_ASKPASS: '/usr/local/bin/askpass',
      ...never,
    },
    hooked: { HOME: '/home/sail', ...never },
    configured: {
      HOME: '/home/sail',
      GIT_CONFIG_PARAMETERS: "'safe.directory'='*'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.https://mirror/.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://origin/',
      ...never,
    },
  });
});

test("a git call in a directory that is not there, or one that outruns its timeout, is a failed result and no throw, naming its subcommand past any -c, and one given no env runs with this process's (review #2.7)", async () => {
  await withTempRepo(async (repo) => {
    const missing = gitSync(join(repo.dir, 'missing'), ['status'], repo.env);
    // An alias that sleeps stands in for a git call that hangs.
    const slow = gitSync(repo.dir, ['-c', 'alias.wait=!sleep 5', 'wait'], repo.env, 200);
    // With no env, git runs with this process's own.
    const ran = gitSync(repo.dir, ['rev-parse', '--is-inside-work-tree']);
    expect({
      missing: missing.code,
      slow: { code: slow.code, said: slow.stderr.startsWith('git wait timed out after 200 ms') },
      ran: { code: ran.code, stdout: ran.stdout },
    }).toEqual({ missing: -1, slow: { code: -1, said: true }, ran: { code: 0, stdout: 'true\n' } });
  });
});

test("a fetch whose signal aborts while it waits to retry a lost ref lock is stopped there: no further git starts, and the error keeps git's message (review R1-1)", async () => {
  await withTempRepo(async (repo) => {
    // A git that always loses the ref lock, and counts its calls.
    const bin = join(repo.dir, 'stub-bin');
    const calls = join(repo.dir, 'calls');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\necho "$*" >> '${calls}'\necho "error: cannot lock ref 'refs/remotes/origin/main': is at a but expected b" >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    const env = { ...repo.env, PATH: `${bin}:${repo.env.PATH ?? ''}` };
    const counted = () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);
    const controller = new AbortController();
    const fetching = fetchRemote(repo.dir, 'origin', env, 10_000, controller.signal).then(
      () => 'fetched',
      (error: unknown) => (error as Error).message,
    );
    // Abort inside the first wait: the first try has run, and the next is 250 ms off.
    while (counted() === 0) await Bun.sleep(5);
    await Bun.sleep(50);
    controller.abort();
    const said = await fetching;
    await Bun.sleep(300);
    expect({ said, calls: counted() }).toEqual({
      said: "workspace.create: git fetch origin stopped: error: cannot lock ref 'refs/remotes/origin/main': is at a but expected b",
      calls: 1,
    });
  });
});

test("a remote's URL keys and logs without its credentials, and any other URL as it is", () => {
  const urls = [
    'https://user:token@github.com/o/r.git',
    'https://token@github.com/o/r',
    'ssh://git@github.com/o/r.git',
    'git@github.com:o/r.git',
    'https://github.com/o/r.git',
    '/srv/git/r.git',
  ];
  expect(urls.map(stripUserinfo)).toEqual([
    'https://github.com/o/r.git',
    'https://github.com/o/r',
    'ssh://github.com/o/r.git',
    'git@github.com:o/r.git',
    'https://github.com/o/r.git',
    '/srv/git/r.git',
  ]);
});

test('a diff over <rev>... or <rev>...HEAD whose rev shares no commit with HEAD is invalid, saying so, while <rev> alone diffs', async () => {
  await withTempRepo(async (repo) => {
    const orphan = repo.git('commit-tree', repo.git('rev-parse', 'HEAD^{tree}'), '-m', 'unrelated');
    const refused = (range: string) => {
      try {
        diffWorkingTree(repo.dir, range, repo.env);
        return 'diffed';
      } catch (error) {
        return { failure: portFailure(error), said: messageOf(error).includes('share no commit') };
      }
    };
    const invalid = { failure: { port: 'workspace', op: 'diff', code: 'invalid' }, said: true };
    expect({
      withHead: refused(`${orphan}...HEAD`),
      bare: refused(`${orphan}...`),
      alone: refused(orphan),
    }).toEqual({ withHead: invalid, bare: invalid, alone: 'diffed' });
  });
});

test.skipIf(process.getuid?.() === 0)(
  'a linked workspace that cannot be unlinked is unavailable, naming the path, and the link stays',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'sail-unlink-'));
    try {
      const runDir = join(root, 'run');
      mkdirSync(runDir);
      const target = join(root, 'elsewhere');
      mkdirSync(target);
      const link = join(runDir, 'workspace');
      symlinkSync(target, link);
      chmodSync(runDir, 0o555);
      let error: unknown;
      try {
        removeWorktree(root, runDir, 'release');
      } catch (thrown) {
        error = thrown;
      } finally {
        chmodSync(runDir, 0o755);
      }
      expect(portFailure(error)).toEqual({ port: 'workspace', op: 'release', code: 'unavailable' });
      expect(messageOf(error)).toContain(link);
      expect(messageOf(error)).toContain('EACCES');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
