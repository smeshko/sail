// The permission engine's matchers: path globs over relative paths, and command patterns over a command's words.
import { expect, test } from 'bun:test';
import { matchesCommand, matchesGlob } from '../../../src/engine/permissions/glob';
import { allow, deny } from '../../../src/engine/permissions/types';

/** Each of `hits` matched and each of `misses` not, as one list so a matcher that matches nothing fails too. */
function outcomes(match: (subject: string) => boolean, hits: string[], misses: string[]): boolean[] {
  return [...hits, ...misses].map(match);
}

function expected(hits: string[], misses: string[]): boolean[] {
  return [...hits.map(() => true), ...misses.map(() => false)];
}

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  .each([
  ['**', ['a', 'a/b/c', ''], []],
  ['src/**', ['src/', 'src/a/b.ts'], ['src', 'srcx/a']],
  ['*.ts', ['a.ts'], ['d/a.ts', 'a.tsx']],
  ['**/x.ts', ['x.ts', 'a/b/x.ts'], ['ax.ts']],
  ['a?c', ['abc'], ['a/c', 'ac']],
  ['a.b+(c)[d]$^|', ['a.b+(c)[d]$^|'], ['aXb+(c)[d]$^|', 'a.bb(c)d$^|']],
  ['{a,b}.ts', ['{a,b}.ts'], ['a.ts', 'b.ts']],
] as [string, string[], string[]][])('the glob %s matches %j and nothing in %j', (glob, hits, misses) => {
  expect(outcomes((path) => matchesGlob(path, [glob]), hits, misses)).toEqual(expected(hits, misses));
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  .each([
  ['git status *', ['git status', 'git status --short'], ['git statusx', 'git log', 'x git status']],
  ['npm test *', ['npm test -- a.test.ts', 'npm test'], ['npm testx', 'npm tes']],
  ['git diff *', ['git diff origin/main...HEAD'], ['git log', 'git difftool']],
  ['true', ['true'], ['true x', 'truex', 'xtrue']],
  ['a?b *', ['a?b x'], ['axb x']],
  ['dart (x).+ *', ['dart (x).+ y'], ['dart Xx).+ y', 'dart (x)xx y']],
  ['bash scripts/**', ['bash scripts/a.sh', 'bash scripts/x/y.sh'], ['bash other/a.sh']],
  ['dart pub deps*', ['dart pub deps', 'dart pub deps --json'], ['dart pub get']],
] as [string, string[], string[]][])('the command pattern %s matches %j and nothing in %j', (pattern, hits, misses) => {
  expect(outcomes((text) => matchesCommand(text, [pattern]), hits, misses)).toEqual(expected(hits, misses));
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a command matches when any one of the patterns does, and nothing matches an empty list', () => {
  expect([
    matchesCommand('head -5', ['git diff *', 'head *']),
    matchesCommand('head -5', []),
    matchesGlob('a', []),
  ]).toEqual([true, false, false]);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('deny() gives the rule and the reason, and allow is the bare verdict', () => {
  expect(deny('write', 'x')).toEqual({ allow: false, rule: 'write', reason: 'x' });
  expect(allow).toEqual({ allow: true });
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a denial without a reason is refused: every denial explains itself', () => {
  expect(() => deny('read', '')).toThrow('reason');
  expect(() => deny('tools', '  ')).toThrow('reason');
});
