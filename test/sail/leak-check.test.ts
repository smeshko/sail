import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nouls, writeOwnSail } from '../helpers/own-sail';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

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

function stage(repo: TempRepo, diff: string) {
  const out = join(repo.home, 'out');
  mkdirSync(out);
  const patch = join(repo.home, 'diff');
  writeFileSync(patch, diff);
  const child = Bun.spawnSync([join(repo.dir, '.sail/workflows/review/stages/03-leak-check/run.sh')], {
    cwd: repo.dir,
    env: {
      ...repo.env,
      PATH: `${join(import.meta.dir, '../../bin')}:${repo.env.PATH}`,
      SAIL_BUN: process.execPath,
      SAIL_CONFIG: join(repo.dir, '.sail/project.yaml'),
      SAIL_HOME: repo.home,
      STAGE_OUT: out,
      INPUT_DIFF: patch,
      INPUT_BASE: 'HEAD',
    },
  });
  return { code: child.exitCode, output: JSON.parse(child.stdout.toString()), request: join(out, 'jev-request.json') };
}
const doc = '+++ b/note.md\n@@ -0,0 +1 @@\n+Some project\n';

test('the stage, with Jev answering a doc line 0.97, adds a jev hit with its yes', async () => {
  await withTempRepo((repo) => {
    writeOwnSail(repo, { jev: nouls({ 'leak-1': 0.97 }) });
    const result = stage(repo, doc);
    expect(result.output.hits).toEqual([{ file: 'note.md', line: 1, match: 'Some project', kind: 'jev', yes: 0.97 }]);
  });
});
test('the stage, with Jev answering every line 0.05, adds no jev hit', async () => {
  await withTempRepo((repo) => {
    writeOwnSail(repo, { jev: nouls({ 'leak-1': 0.05 }) });
    const result = stage(repo, doc);
    expect(result.output.hits).toEqual([]);
    expect(result.output.jev.asked).toBe(true);
  });
});
test('the stage asks Jev nothing when the diff adds only code lines', async () => {
  await withTempRepo((repo) => {
    writeOwnSail(repo, { jev: nouls({}) });
    const result = stage(repo, '+++ b/x.ts\n@@ -0,0 +1 @@\n+const x = 1;\n');
    expect(result.output.jev.lines).toBe(0);
    expect(existsSync(result.request)).toBe(false);
  });
});
test('the Jev request never holds the denylist or its path', async () => {
  await withTempRepo((repo) => {
    writeOwnSail(repo, { jev: nouls({ 'leak-1': 0.05 }) });
    writeFileSync(join(repo.home, 'leak-denylist.txt'), 'Secretname\nOthername\n');
    const result = stage(repo, `${doc}+++ b/x.ts\n@@ -0,0 +1 @@\n+const x = Secretname;\n`);
    expect(result.output.hits).toEqual([{ file: 'x.ts', line: 1, match: 'Secretname', kind: 'denylist' }]);
    const request = readFileSync(result.request, 'utf8');
    expect(request.includes('Secretname')).toBe(false);
    expect(request.includes('Othername')).toBe(false);
    expect(request.includes(repo.home)).toBe(false);
  });
});
test('the stage, with no adapters.jev, exits 0 with the exact scan’s hits', async () => {
  await withTempRepo((repo) => {
    writeOwnSail(repo);
    const result = stage(repo, `${doc}+++ b/x.ts\n@@ -0,0 +1 @@\n+const key = "XYZ-123";\n`);
    expect(result.code).toBe(0);
    expect(result.output.hits).toEqual([{ file: 'x.ts', line: 1, match: 'XYZ-123', kind: 'key' }]);
    expect(result.output.jev.asked).toBe(false);
    expect(typeof result.output.jev.note).toBe('string');
  });
});

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
