// runDirDiff(): the readable difference between two run directories (11.3 D9).
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDirDiff } from './run-diff';

const temp = mkdtempSync(join(tmpdir(), 'sail-run-diff-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let made = 0;

/** A run directory of `files`, in a folder of its own. */
function runDir(files: Record<string, string>): string {
  const dir = join(temp, String(++made));
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const numbered = (count: number, change: Record<number, string> = {}): string =>
  Array.from({ length: count }, (_, index) => change[index + 1] ?? `line ${index + 1}`).join('\n');

test('two equal runs have no difference', () => {
  const files = { 'a.json': '{}\n', 'x/b.log': 'hi\n' };
  expect(runDirDiff(runDir(files), runDir(files))).toBe('');
});

test('a file the generated run lacks and a file it adds are one named line each', () => {
  const stored = runDir({ 'both.txt': 'x', 'gone.txt': 'y' });
  const generated = runDir({ 'both.txt': 'x', 'new/extra.txt': 'z' });
  expect(runDirDiff(generated, stored)).toBe(
    [
      'gone.txt is missing from the generated run',
      'new/extra.txt is not in the stored run',
      'run bun run golden to regenerate it',
    ].join('\n'),
  );
});

test('a changed line is named with its file and line number, both values and two lines of context', () => {
  const stored = runDir({ '01-spec/call-1/result.json': numbered(9) });
  const generated = runDir({ '01-spec/call-1/result.json': numbered(9, { 5: 'line five, changed' }) });
  expect(runDirDiff(generated, stored)).toBe(
    [
      '01-spec/call-1/result.json differs from the stored run (- stored, + generated):',
      '  @@ 01-spec/call-1/result.json line 5 @@',
      '    line 3',
      '    line 4',
      '  - line 5',
      '  + line five, changed',
      '    line 6',
      '    line 7',
      'run bun run golden to regenerate it',
    ].join('\n'),
  );
});

test('an added and a removed line are told apart from a changed one, with the right line numbers', () => {
  const stored = runDir({ 'f.txt': 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj' });
  const generated = runDir({ 'f.txt': 'a\nb\nc\nd\nNEW\ne\nf\ng\nh\nj' });
  const diff = runDirDiff(generated, stored);
  expect(diff).toContain('  @@ f.txt line 5 @@\n    c\n    d\n  + NEW\n    e\n    f');
  expect(diff).toContain('  - i\n');
});

test('only the first 3 hunks of a file are shown, with a count of the rest', () => {
  const changes = { 3: 'X3', 13: 'X13', 23: 'X23', 33: 'X33', 43: 'X43' };
  const diff = runDirDiff(runDir({ 'f.txt': numbered(50, changes) }), runDir({ 'f.txt': numbered(50) }));
  expect(diff.match(/@@ f\.txt line/g)).toHaveLength(3);
  expect(diff).toContain('+ X23');
  expect(diff).not.toContain('+ X33');
  expect(diff).toContain('(2 more hunks not shown)');
  expect(
    runDirDiff(
      runDir({ 'f.txt': numbered(50, { 3: 'X', 13: 'Y', 23: 'Z', 33: 'W' }) }),
      runDir({ 'f.txt': numbered(50) }),
    ),
  ).toContain('(1 more hunk not shown)');
});

test('changes close together share one hunk', () => {
  const diff = runDirDiff(runDir({ 'f.txt': numbered(12, { 4: 'A', 6: 'B' }) }), runDir({ 'f.txt': numbered(12) }));
  expect(diff.match(/@@ f\.txt line/g)).toHaveLength(1);
});

test('a line longer than 200 characters is cut', () => {
  const long = 'x'.repeat(500);
  const diff = runDirDiff(runDir({ 'f.txt': long }), runDir({ 'f.txt': 'short' }));
  expect(diff).toContain(`+ ${'x'.repeat(200)}…`);
  expect(diff).not.toContain('x'.repeat(201));
});

test("run.json's sail.runtime alone differing is no difference, and any other field of it is", () => {
  const header = (runtime: string, version = '0.0.0') =>
    `{\n  "sail": {\n    "version": "${version}",\n    "runtime": "${runtime}"\n  }\n}\n`;
  const stored = runDir({ 'run.json': header('bun 1.3.14') });
  expect(runDirDiff(runDir({ 'run.json': header('bun 1.4.2') }), stored)).toBe('');
  expect(runDirDiff(runDir({ 'run.json': header('bun 1.4.2', '0.0.1') }), stored)).toContain(
    '+     "version": "0.0.1",',
  );
});

test('files too long to compare line by line differ as a whole, and stay readable', () => {
  const [a, b] = [numbered(2100), Array.from({ length: 2100 }, (_, index) => `other ${index}`).join('\n')];
  const diff = runDirDiff(runDir({ 'big.txt': b }), runDir({ 'big.txt': a }));
  expect(diff).toContain('big.txt differs from the stored run');
  expect(diff.match(/@@ big\.txt line/g)).toHaveLength(1);
});
