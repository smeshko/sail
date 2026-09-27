import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLine, createFileOnce, replaceFile, syncDir } from '../../src/engine/durable';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-durable-'));
  dirs.push(dir);
  return dir;
}

test('createFileOnce writes the file, and refuses one that exists', () => {
  const path = join(tempDir(), 'once.txt');
  createFileOnce(path, 'hello\n');
  expect(readFileSync(path, 'utf8')).toBe('hello\n');
  expect(() => createFileOnce(path, 'again\n')).toThrow(expect.objectContaining({ code: 'EEXIST' }));
  expect(readFileSync(path, 'utf8')).toBe('hello\n');
});

test('createFileOnce with a mode leaves those mode bits', () => {
  const path = join(tempDir(), 'read-only.json');
  createFileOnce(path, '{}\n', 0o444);
  expect(statSync(path).mode & 0o777).toBe(0o444);
});

test('appendLine adds the line and its newline, keeping what was there', () => {
  const path = join(tempDir(), 'lines.ndjson');
  appendLine(path, 'one');
  appendLine(path, 'two');
  expect(readFileSync(path, 'utf8')).toBe('one\ntwo\n');
});

test('appendLine refuses a line holding a newline, and writes nothing', () => {
  const path = join(tempDir(), 'lines.ndjson');
  expect(() => appendLine(path, 'one\ntwo')).toThrow('newline');
  expect(existsSync(path)).toBe(false);
});

test('replaceFile replaces the file whole and leaves no .tmp behind', () => {
  const dir = tempDir();
  const path = join(dir, 'STATUS');
  writeFileSync(path, 'running\n');
  replaceFile(path, 'completed\n');
  expect(readFileSync(path, 'utf8')).toBe('completed\n');
  expect(readdirSync(dir)).toEqual(['STATUS']);
});

test('syncDir syncs a directory, and throws for one that is missing', () => {
  const dir = tempDir();
  expect(() => syncDir(dir)).not.toThrow();
  expect(() => syncDir(join(dir, 'missing'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
});
