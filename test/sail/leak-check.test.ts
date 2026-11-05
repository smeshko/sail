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
  leakQuestions(lines: Line[], start?: number): Record<string, { type: string; instructions: string }>;
  leakState(lines: Line[], start?: number): unknown;
  leakRequests(lines: Line[]): { state: unknown; questions: Record<string, unknown> }[];
  MAX_REQUEST_BYTES: number;
}
const lib = (await import(join(import.meta.dir, '../../.sail/lib/jev-check.mjs'))) as Lib;
const lines = [
  { file: 'a.md', line: 2, text: 'Hello' },
  { file: 'a.ts', line: 4, text: '// comment' },
];

function stage(repo: TempRepo, diff: string, base = repo.git('rev-parse', 'HEAD').trim()) {
  const out = join(repo.home, 'out');
  mkdirSync(out);
  const patch = join(repo.home, 'diff');
  writeFileSync(patch, diff);
  const baseFile = join(repo.home, 'base.txt');
  writeFileSync(baseFile, `${base}\n`);
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
      INPUT_BASE: baseFile,
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

test('the stage reads the base binding file before listing commit messages', async () => {
  await withTempRepo((repo) => {
    writeOwnSail(repo, { jev: nouls({ 'leak-1': 0.97 }) });
    const base = repo.git('rev-parse', 'HEAD').trim();
    repo.git('commit', '--allow-empty', '-m', 'Some project');
    const sha = repo.git('rev-parse', '--short', 'HEAD').trim();
    const result = stage(repo, '', base);
    expect(result.output.hits).toEqual([
      { file: `commit ${sha}`, line: 1, match: 'Some project', kind: 'jev', yes: 0.97 },
    ]);
  });
});

test('the stage asks about every added doc line beyond 400', async () => {
  await withTempRepo((repo) => {
    writeOwnSail(repo, { jev: nouls({ 'leak-401': 0.97 }) });
    const diff = `+++ b/note.md\n@@ -0,0 +1,401 @@\n${Array.from({ length: 401 }, () => '+Some project').join('\n')}\n`;
    const result = stage(repo, diff);
    expect(result.output.jev).toMatchObject({ asked: true, note: '', lines: 401 });
    expect(existsSync(join(repo.home, 'out', 'jev-request-2.json'))).toBe(true);
    expect(result.output.hits).toContainEqual({
      file: 'note.md',
      line: 401,
      match: 'Some project',
      kind: 'jev',
      yes: 0.97,
    });
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
test('leakRequests splits the lines into requests under the byte limit, each as full as it can be, numbered across them', () => {
  const many = Array.from({ length: 900 }, (_, i) => ({
    file: 'note.md',
    line: i + 1,
    text: `Line ${i} ${'x'.repeat(i % 97)}`,
  }));
  const requests = lib.leakRequests(many);
  const size = (state: unknown, questions: unknown) => Buffer.byteLength(JSON.stringify({ state, questions }));
  expect(requests.length).toBeGreaterThan(1);
  expect(requests.flatMap((request) => Object.keys(request.questions))).toEqual(many.map((_, i) => `leak-${i + 1}`));
  let start = 0;
  for (const [index, request] of requests.entries()) {
    const count = Object.keys(request.questions).length;
    expect(request.state).toEqual(lib.leakState(many.slice(start, start + count), start));
    expect(request.questions).toEqual(lib.leakQuestions(many.slice(start, start + count), start));
    expect(size(request.state, request.questions)).toBeLessThanOrEqual(lib.MAX_REQUEST_BYTES);
    if (index < requests.length - 1) {
      const more = many.slice(start, start + count + 1);
      expect(size(lib.leakState(more, start), lib.leakQuestions(more, start))).toBeGreaterThan(lib.MAX_REQUEST_BYTES);
    }
    start += count;
  }
});
test('leakRequests keeps a few lines in one request, and a line over the limit alone in its own', () => {
  expect(lib.leakRequests(lines)).toEqual([{ state: lib.leakState(lines), questions: lib.leakQuestions(lines) }]);
  const huge = { file: 'a.md', line: 3, text: 'y'.repeat(lib.MAX_REQUEST_BYTES) };
  expect(lib.leakRequests([...lines, huge, lines[0] as Line]).map((request) => Object.keys(request.questions))).toEqual(
    [['leak-1', 'leak-2'], ['leak-3'], ['leak-4']],
  );
});
test('the stage keeps the answers of the requests Jev answered and notes the one it could not ask', async () => {
  await withTempRepo((repo) => {
    writeOwnSail(repo, { jev: nouls({ 'leak-1': 0.97 }) });
    const diff = `+++ b/note.md\n@@ -0,0 +1,2 @@\n+Some project\n+${'y'.repeat(70_000)}\n`;
    const result = stage(repo, diff);
    expect(result.output.hits).toContainEqual({
      file: 'note.md',
      line: 1,
      match: 'Some project',
      kind: 'jev',
      yes: 0.97,
    });
    expect(result.output.jev.asked).toBe(true);
    expect(result.output.jev.note).toStartWith('1 of 2 requests not asked: the request is ');
  });
});
