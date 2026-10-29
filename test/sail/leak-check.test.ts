import { expect, test } from 'bun:test';
import { join } from 'node:path';

interface Line {
  file: string;
  line: number;
  text: string;
}
interface Lib {
  LEAK_YES: number;
  SAIL_NOTE: string;
  leakLines(diff: string): Line[];
  commitLines(log: string): Line[];
  leakState(lines: Line[]): unknown;
  leakQuestions(lines: Line[]): Record<string, { type: string; instructions: string }>;
}
const lib = (await import(join(import.meta.dir, '../../.sail/lib/jev-check.mjs'))) as Lib;
const lines = [
  { file: 'a.md', line: 2, text: 'Hello' },
  { file: 'a.ts', line: 4, text: '// comment' },
];

test('leakLines picks doc, comment and only comment lines', () => {
  const diff =
    '+++ b/a.md\n@@ -1,2 +2,4 @@\n+Hello\n+123\n+ \n-removed\n+++ b/a.ts\n@@ -1 +4,3 @@\n+// comment\n+const x = 1;\n+#private\n+++ b/a.yaml\n@@ -0,0 +1 @@\n+# config\n+++ b/a.json\n@@ -0,0 +1 @@\n+// no';
  expect(lib.leakLines(diff)).toEqual([...lines, { file: 'a.yaml', line: 1, text: '# config' }]);
});
test('commitLines numbers each message line under its commit', () => {
  expect(lib.commitLines('abc1234\0subject\n\nbody\n\x1edef5678\0other\n\x1e')).toEqual([
    { file: 'commit abc1234', line: 1, text: 'subject' },
    { file: 'commit abc1234', line: 3, text: 'body' },
    { file: 'commit def5678', line: 1, text: 'other' },
  ]);
});
test('leakState is the note and the lines alone', () => {
  expect(lib.leakState(lines)).toEqual({ note: lib.SAIL_NOTE, lines: { 'leak-1': lines[0], 'leak-2': lines[1] } });
});
test('leakQuestions asks one noul per line named leak-<n>', () => {
  const questions = lib.leakQuestions(lines);
  expect(Object.keys(questions)).toEqual(['leak-1', 'leak-2']);
  expect(questions['leak-1']?.type).toBe('noul');
  expect(questions['leak-2']?.instructions).toContain('lines.leak-2');
  expect(lib.LEAK_YES).toBe(0.8);
});
