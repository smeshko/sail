import { expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, relative } from 'node:path';

const testHome = process.env.SAIL_TEST_HOME;

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

test('HOME is the launcher throwaway directory under the temp dir', () => {
  expect(testHome).toBeDefined();
  expect(homedir()).toBe(testHome as string);
  expect(isInside(realpathSync(tmpdir()), homedir())).toBe(true);
});

test('a spawn with no env sees the throwaway HOME', () => {
  const result = Bun.spawnSync(['sh', '-c', 'echo "$HOME"']);
  expect(result.stdout.toString().trim()).toBe(testHome as string);
});

test('no global git config is reachable', () => {
  const result = Bun.spawnSync(['git', 'config', '--global', '--list']);
  expect(result.exitCode).not.toBe(0);
});

test('inherited git location variables are stripped', () => {
  expect(process.env.GIT_DIR).toBeUndefined();
  expect(process.env.GIT_WORK_TREE).toBeUndefined();
});
