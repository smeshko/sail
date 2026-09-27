import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callPaths, createCallDir } from '../../src/engine/call-dir';
import { recordFiles, validateOutput } from '../../src/engine/contract';
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
