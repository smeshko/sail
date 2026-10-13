// The diff of a git-worktree workspace, with git replaced by a runner that answers as git does for an entry it cannot read:
// `git diff --no-index` exits 1, as it does for a file that differs, but says on stderr what it could not read.
import { expect, test } from 'bun:test';
import { diffFrom, type GitRunner } from '../../src/adapters/worktree-git';
import { portFailure, rejection } from '../helpers/ports';

test('an untracked entry that git exits 1 on, with a message on stderr, fails the diff instead of leaving it out', async () => {
  const git: GitRunner = async (_cwd, args) => {
    if (args[0] === 'ls-files') return { code: 0, stdout: 'linked-dir\0', stderr: '' };
    if (args.includes('--no-index')) {
      return { code: 1, stdout: '', stderr: "error: Could not access 'linked-dir/null'" };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const error = await rejection(diffFrom(git, '/unused', 'abc'));
  expect(portFailure(error)).toEqual({ port: 'workspace', op: 'diff', code: 'unavailable' });
});
