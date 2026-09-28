import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callPaths, createCallDir } from '../../src/engine/call-dir';
import { producesProblems, recordFiles, validateOutput } from '../../src/engine/contract';
import { z } from '../../src/sdk/index';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function callDir(): { runDir: string; outDir: string } {
  const runDir = mkdtempSync(join(tmpdir(), 'sail-contract-'));
  dirs.push(runDir);
  const paths = callPaths(runDir, 3, 'tests', 1);
  createCallDir(paths);
  return { runDir, outDir: paths.dir };
}

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

test('validateOutput gives the parsed value, defaults applied', () => {
  const schema = z.object({ ok: z.boolean(), tags: z.array(z.string()).default([]) });
  expect(validateOutput(schema, { ok: true })).toEqual({ ok: true, data: { ok: true, tags: [] } });
});

test("validateOutput gives Zod's message for every issue", () => {
  const schema = z.object({ ok: z.boolean(), total: z.number() });
  expect(validateOutput(schema, { ok: 'yes' })).toEqual({
    ok: false,
    message:
      '✖ Invalid input: expected boolean, received string\n  → at ok\n' +
      '✖ Invalid input: expected number, received undefined\n  → at total',
  });
});

test('recordFiles records each declared file by its run-relative path, size and sha256', () => {
  const { runDir, outDir } = callDir();
  writeFileSync(join(outDir, 'junit.xml'), '<testsuites/>\n');
  writeFileSync(join(outDir, 'report.md'), '');
  expect(recordFiles({ 'junit.xml': 'file', 'report.md': 'file' }, outDir, runDir)).toEqual({
    files: {
      'junit.xml': { path: '03-tests/call-1/junit.xml', bytes: 14, sha256: sha256('<testsuites/>\n') },
      'report.md': { path: '03-tests/call-1/report.md', bytes: 0, sha256: sha256('') },
    },
    errors: [],
  });
});

test('a large file is hashed whole', () => {
  const { runDir, outDir } = callDir();
  const text = 'x'.repeat(3 * 1024 * 1024 + 7);
  writeFileSync(join(outDir, 'big.log'), text);
  expect(recordFiles({ 'big.log': 'file' }, outDir, runDir).files['big.log']).toMatchObject({
    bytes: text.length,
    sha256: sha256(text),
  });
});

test('a declared file that is missing, or is not a regular file, is a missing_file error', () => {
  const { runDir, outDir } = callDir();
  mkdirSync(join(outDir, 'report'));
  expect(recordFiles({ 'junit.xml': 'file', report: 'file' }, outDir, runDir)).toEqual({
    files: {},
    errors: [
      { reason: 'missing_file', message: "'junit.xml' was not produced in $STAGE_OUT" },
      { reason: 'missing_file', message: "'report' in $STAGE_OUT is not a regular file" },
    ],
  });
});

test('a declared file that is a symlink is a missing_file error, even to a real file', () => {
  const { runDir, outDir } = callDir();
  const outside = join(runDir, 'outside.xml');
  writeFileSync(outside, '<testsuites/>\n');
  symlinkSync(outside, join(outDir, 'junit.xml'));
  expect(recordFiles({ 'junit.xml': 'file' }, outDir, runDir)).toEqual({
    files: {},
    errors: [{ reason: 'missing_file', message: "'junit.xml' in $STAGE_OUT is not a regular file" }],
  });
});

test('producesProblems refuses a name that is not a plain file name, or that the engine writes', () => {
  expect(producesProblems({ 'junit.xml': 'file', '.hidden': 'file' })).toEqual([]);
  expect(
    producesProblems({ '../secret': 'file', 'a/b.md': 'file', 'a\\b.md': 'file', '..': 'file', '.': 'file' }),
  ).toEqual([
    "'../secret' can't be produced: it is not a plain file name",
    "'a/b.md' can't be produced: it is not a plain file name",
    "'a\\b.md' can't be produced: it is not a plain file name",
    "'..' can't be produced: it is not a plain file name",
    "'.' can't be produced: it is not a plain file name",
  ]);
  expect(producesProblems({ 'result.json': 'file', in: 'file' })).toEqual([
    "'result.json' can't be produced: the engine writes it in $STAGE_OUT",
    "'in' can't be produced: the engine writes it in $STAGE_OUT",
  ]);
});

test("producesProblems refuses try-<n>, the name of a later try's directory", () => {
  expect(producesProblems({ 'try-2': 'file', 'try-x': 'file', 'try-2.txt': 'file' })).toEqual([
    "'try-2' can't be produced: the engine uses it for a later try",
  ]);
});

test('a declared file named __proto__ is recorded, and survives JSON', () => {
  const { runDir, outDir } = callDir();
  writeFileSync(join(outDir, '__proto__'), 'x');
  const { files, errors } = recordFiles({ ['__proto__']: 'file' }, outDir, runDir);
  expect(errors).toEqual([]);
  expect(Object.keys(JSON.parse(JSON.stringify(files)))).toEqual(['__proto__']);
});

test.skipIf(process.getuid?.() === 0)('a declared file that cannot be read is a missing_file error, naming why', () => {
  const { runDir, outDir } = callDir();
  writeFileSync(join(outDir, 'junit.xml'), '<testsuites/>\n');
  chmodSync(join(outDir, 'junit.xml'), 0);
  expect(recordFiles({ 'junit.xml': 'file' }, outDir, runDir)).toEqual({
    files: {},
    errors: [{ reason: 'missing_file', message: "'junit.xml' in $STAGE_OUT can't be read (EACCES)" }],
  });
});
