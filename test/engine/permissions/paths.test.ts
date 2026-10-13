import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expandStageOut, globToRegExp, matchesAny, resolveReal, rootOf } from '../../../src/engine/permissions/paths';
import { permissionRoots } from '../../helpers/permission-roots';
import { withTempRepo } from '../../helpers/temp-repo';

test('a ** glob matches a file at any depth and a * stays within one segment', () => {
  expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true);
  expect(globToRegExp('**/*.ts').test('x/y/a.ts')).toBe(true);
  expect(globToRegExp('lib/*').test('lib/a/b')).toBe(false);
});

test('lib/** matches below lib and not a sibling that shares its prefix', () => {
  expect(matchesAny('lib/x/a.ts', ['lib/**'])).toBe(true);
  expect(matchesAny('lib-other/a', ['lib/**'])).toBe(false);
});

test('the $STAGE_OUT prefix expands to the call directory before matching', () => {
  const stageOut = '/work/call/out';
  const globs = [expandStageOut('$STAGE_OUT/**', stageOut)];
  expect(matchesAny(join(stageOut, 'out.md'), globs)).toBe(true);
  expect(matchesAny(join(stageOut, '..', 'in', 'a.md'), globs)).toBe(false);
});

test('a path that climbs out of the worktree resolves outside every root', async () => {
  await withTempRepo(async (repo) => {
    const { roots, base } = permissionRoots(repo);
    const resolved = resolveReal('../../etc/passwd', roots.worktree);
    expect(resolved).toBe(join(dirname(base), 'etc', 'passwd'));
    expect(rootOf(resolved ?? '', roots)).toBeNull();
  });
});

test('a symlink in the worktree that points outside it resolves outside', async () => {
  await withTempRepo(async (repo) => {
    const { roots, elsewhere } = permissionRoots(repo);
    symlinkSync(elsewhere, join(roots.worktree, 'link'));
    const resolved = resolveReal('link/a.txt', roots.worktree);
    expect(resolved).toBe(join(elsewhere, 'a.txt'));
    expect(rootOf(resolved ?? '', roots)).toBeNull();
  });
});

test('a symlink in the worktree that points inside it resolves inside', async () => {
  await withTempRepo(async (repo) => {
    const { roots } = permissionRoots(repo);
    mkdirSync(join(roots.worktree, 'real'));
    symlinkSync(join(roots.worktree, 'real'), join(roots.worktree, 'alias'));
    const resolved = resolveReal('alias/a.txt', roots.worktree);
    expect(resolved).toBe(join(roots.worktree, 'real', 'a.txt'));
    expect(rootOf(resolved ?? '', roots)).toBe('worktree');
  });
});

test('a dangling symlink whose target lies outside the roots resolves outside', async () => {
  await withTempRepo(async (repo) => {
    const { roots, elsewhere } = permissionRoots(repo);
    symlinkSync(join(elsewhere, 'missing.txt'), join(roots.worktree, 'dangle'));
    const resolved = resolveReal('dangle', roots.worktree);
    expect(resolved).toBe(join(elsewhere, 'missing.txt'));
    expect(rootOf(resolved ?? '', roots)).toBeNull();
  });
});

test('a path that does not exist yet under the worktree resolves inside it', async () => {
  await withTempRepo(async (repo) => {
    const { roots } = permissionRoots(repo);
    const resolved = resolveReal('new/deep/file.ts', roots.worktree);
    expect(resolved).toBe(join(roots.worktree, 'new', 'deep', 'file.ts'));
    expect(rootOf(resolved ?? '', roots)).toBe('worktree');
  });
});

test('a path starting with ~ is unresolvable', async () => {
  await withTempRepo(async (repo) => {
    const { roots } = permissionRoots(repo);
    expect(resolveReal('~/x', roots.worktree)).toBeNull();
  });
});
