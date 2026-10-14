// The git plumbing the Workspace adapters share (D7): every call is non-interactive, a call that can't run or runs too
// long is a failed result rather than a throw, and a remote's URL loses its credentials before anything keys or logs
// it.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { gitSync, nonInteractive, stripUserinfo } from '../../../src/adapters/workspace/git';
import { withTempRepo } from '../../helpers/temp-repo';

test
  ("git never asks: no terminal prompt, no credential manager dialog, and an ssh in batch mode unless the caller's own is set", () => {
  const plain = nonInteractive({ HOME: '/home/sail' });
  const own = nonInteractive({ HOME: '/home/sail', GIT_SSH_COMMAND: 'ssh -i key', GIT_TERMINAL_PROMPT: '1' });
  expect({ plain, own }).toEqual({
    plain: {
      HOME: '/home/sail',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    },
    own: { HOME: '/home/sail', GIT_SSH_COMMAND: 'ssh -i key', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
});

test
  ("a git call in a directory that is not there, or one that outruns its timeout, is a failed result and no throw, and one given no env runs with this process's", async () => {
  await withTempRepo(async (repo) => {
    const missing = gitSync(join(repo.dir, 'missing'), ['status'], repo.env);
    // An alias that sleeps stands in for a git call that hangs.
    const slow = gitSync(repo.dir, ['-c', 'alias.wait=!sleep 5', 'wait'], repo.env, 200);
    // With no env, git runs with this process's own.
    const ran = gitSync(repo.dir, ['rev-parse', '--is-inside-work-tree']);
    expect({
      missing: missing.code,
      slow: { code: slow.code, said: slow.stderr.includes('timed out after 200 ms') },
      ran: { code: ran.code, stdout: ran.stdout },
    }).toEqual({ missing: -1, slow: { code: -1, said: true }, ran: { code: 0, stdout: 'true\n' } });
  });
});

test
  ("a remote's URL keys and logs without its credentials, and any other URL as it is", () => {
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
