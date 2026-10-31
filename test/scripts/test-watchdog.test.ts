// The silence watchdog's helpers: when it runs, and a process's tree out of a `ps` listing.
import { expect, test } from 'bun:test';
import { descendants, SILENCE_SECONDS, silenceSeconds } from '../../scripts/test-watchdog';

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
