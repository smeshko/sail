// The silence watchdog's helpers: when it runs, and a process's tree out of a `ps` listing.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  descendants,
  markEnded,
  markStarted,
  runningFiles,
  SILENCE_SECONDS,
  silenceSeconds,
  workerFiles,
} from '../../scripts/test-watchdog';

test('silenceSeconds is 600 on CI and off with no CI and no variable', () => {
  expect(SILENCE_SECONDS).toBe(600);
  expect(silenceSeconds({ CI: 'true' })).toBe(600);
  expect(silenceSeconds({})).toBeUndefined();
  expect(silenceSeconds({ CI: '' })).toBeUndefined();
  expect(silenceSeconds({ CI: 'false' })).toBeUndefined();
});

test('silenceSeconds takes the variable anywhere, 0 turns it off, and a value that is no number falls back to 600', () => {
  expect(silenceSeconds({ SAIL_TEST_SILENCE_SECONDS: '5' })).toBe(5);
  expect(silenceSeconds({ CI: 'true', SAIL_TEST_SILENCE_SECONDS: '5' })).toBe(5);
  expect(silenceSeconds({ SAIL_TEST_SILENCE_SECONDS: '0' })).toBeUndefined();
  expect(silenceSeconds({ CI: 'true', SAIL_TEST_SILENCE_SECONDS: '0' })).toBeUndefined();
  expect(silenceSeconds({ SAIL_TEST_SILENCE_SECONDS: '3m' })).toBe(600);
  expect(silenceSeconds({ SAIL_TEST_SILENCE_SECONDS: '-5' })).toBe(600);
  expect(silenceSeconds({ SAIL_TEST_SILENCE_SECONDS: '' })).toBeUndefined();
});

const PS = [
  '  100     1       10:00 Ss   bun scripts/test.ts',
  '  200   100       09:59 S    bun test --parallel=4',
  '  300   200       09:58 S    bun test worker',
  '  400   300       09:57 S    git status --porcelain',
  '  500     1       09:00 S    unrelated process',
  '  600   500       08:00 S    child of unrelated',
  'garbage line',
  '  abc   100       01:00 S    not a pid',
].join('\n');

test('descendants returns the root, its children and grandchildren, each after its parent, and nothing unrelated', () => {
  const lines = descendants(PS, 100);
  expect(lines.map((line) => line.trim().split(/\s+/)[0])).toEqual(['100', '200', '300', '400']);
  expect(lines[3]).toContain('git status --porcelain');
});

test('descendants of a leaf is the leaf alone, and of an absent pid is empty', () => {
  expect(descendants(PS, 400).map((line) => line.trim().split(/\s+/)[0])).toEqual(['400']);
  expect(descendants(PS, 999)).toEqual([]);
});

const scratch = () => mkdtempSync(join(process.env.SAIL_TEST_HOME ?? '', 'markers-'));

test('markStarted then runningFiles returns the pid with its file, and a second start replaces it', () => {
  const dir = join(scratch(), 'running');
  markStarted(dir, 300, '/a/one.test.ts');
  expect(runningFiles(dir)).toEqual(new Map([[300, '/a/one.test.ts']]));
  markStarted(dir, 300, '/a/two.test.ts');
  expect(runningFiles(dir)).toEqual(new Map([[300, '/a/two.test.ts']]));
});

test('markEnded removes the marker only while it names that file', () => {
  const dir = join(scratch(), 'running');
  markStarted(dir, 300, '/a/one.test.ts');
  markEnded(dir, 300, '/a/other.test.ts');
  expect(runningFiles(dir)).toEqual(new Map([[300, '/a/one.test.ts']]));
  markEnded(dir, 300, '/a/one.test.ts');
  expect(runningFiles(dir).size).toBe(0);
});

test('markers never throw, and a missing directory has no running files', () => {
  expect(() => markStarted(undefined, 1, '/a')).not.toThrow();
  expect(() => markEnded(undefined, 1, '/a')).not.toThrow();
  const blocker = join(scratch(), 'file');
  writeFileSync(blocker, 'x');
  expect(() => markStarted(join(blocker, 'sub'), 1, '/a')).not.toThrow();
  expect(() => markEnded(join(blocker, 'sub'), 1, '/a')).not.toThrow();
  expect(runningFiles(join(scratch(), 'missing')).size).toBe(0);
});

test('runningFiles ignores a file whose name is no pid', () => {
  const dir = join(scratch(), 'running');
  mkdirSync(dir);
  writeFileSync(join(dir, 'notes'), '/a/x.test.ts');
  writeFileSync(join(dir, '12'), '/a/y.test.ts');
  expect(runningFiles(dir)).toEqual(new Map([[12, '/a/y.test.ts']]));
});

test('workerFiles lists the tree processes that have a marker, relative to cwd when under it', () => {
  const tree = descendants(PS, 100);
  const files = new Map([
    [300, '/repo/test/a.test.ts'],
    [500, '/repo/test/unrelated.test.ts'],
  ]);
  expect(workerFiles(tree, files, '/repo')).toEqual(['  300  test/a.test.ts']);
  expect(workerFiles(tree, new Map([[300, '/elsewhere/b.test.ts']]), '/repo')).toEqual(['  300  /elsewhere/b.test.ts']);
  expect(workerFiles(tree, new Map([[500, '/repo/x.test.ts']]), '/repo')).toEqual([]);
});
