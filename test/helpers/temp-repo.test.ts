import { expect, test } from 'bun:test';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { type TempRepo, withTempRepo } from './temp-repo';

const checkoutRoot = realpathSync(join(import.meta.dir, '..', '..'));
const tempRoot = realpathSync(tmpdir());

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

test('each call gets its own repository and HOME under the temp dir, outside the checkout', async () => {
  const [a, b] = await Promise.all([withTempRepo((repo) => repo), withTempRepo((repo) => repo)]);
  expect(a.dir).not.toBe(b.dir);
  expect(a.home).not.toBe(b.home);
  for (const repo of [a, b]) {
    expect(isInside(tempRoot, repo.dir)).toBe(true);
    expect(isInside(tempRoot, repo.home)).toBe(true);
    expect(relative(checkoutRoot, repo.dir).startsWith('..')).toBe(true);
    expect(isInside(repo.dir, repo.home)).toBe(false);
  }
});

test('the repository is on main with one commit by the test identity', async () => {
  await withTempRepo((repo) => {
    expect(repo.git('rev-parse', '--show-toplevel')).toBe(repo.dir);
    expect(repo.git('branch', '--show-current')).toBe('main');
    expect(repo.git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(repo.git('log', '-1', '--format=%ae')).toBe('test@sail.invalid');
  });
});

test('no global git config is reachable', async () => {
  await withTempRepo((repo) => {
    expect(() => repo.git('config', '--global', '--list')).toThrow();
  });
});

test('a spawn given repo.env sees repo.home', async () => {
  await withTempRepo((repo) => {
    const result = Bun.spawnSync(['sh', '-c', 'echo "$HOME"'], { env: repo.env });
    expect(result.stdout.toString().trim()).toBe(repo.home);
  });
});

test('cleanup runs after fn resolves, and the return value passes through', async () => {
  let seen: TempRepo | undefined;
  const result = await withTempRepo(async (repo) => {
    seen = repo;
    expect(existsSync(repo.dir)).toBe(true);
    expect(existsSync(repo.home)).toBe(true);
    return 42;
  });
  expect(result).toBe(42);
  expect(seen).toBeDefined();
  expect(existsSync(seen?.dir as string)).toBe(false);
  expect(existsSync(seen?.home as string)).toBe(false);
});

test('cleanup runs after fn throws, and the same error reaches the caller', async () => {
  const boom = new Error('boom');
  let seen: TempRepo | undefined;
  const outcome = withTempRepo((repo) => {
    seen = repo;
    throw boom;
  });
  await expect(outcome).rejects.toBe(boom);
  expect(existsSync(seen?.dir as string)).toBe(false);
  expect(existsSync(seen?.home as string)).toBe(false);
});

test('a failing git command throws with its stderr', async () => {
  await withTempRepo((repo) => {
    expect(() => repo.git('no-such-command')).toThrow(/is not a git command/);
  });
});
