import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLine, createDir, createFileOnce, replaceFile, syncDir } from '../../src/engine/durable';
import { syncedDirs } from '../helpers/synced-dirs';

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

test("replaceFile through the caller's own temp path leaves no temp file, and never touches <path>.tmp", () => {
  const dir = tempDir();
  const path = join(dir, 'summary.json');
  writeFileSync(`${path}.tmp`, 'another writer\n');
  replaceFile(path, '{}\n', `${path}.123.tmp`);
  expect(readdirSync(dir).sort()).toEqual(['summary.json', 'summary.json.tmp']);
  expect([readFileSync(path, 'utf8'), readFileSync(`${path}.tmp`, 'utf8')]).toEqual(['{}\n', 'another writer\n']);
});

test('createDir creates the directory, then syncs the one holding it', () => {
  const dir = tempDir();
  const path = join(dir, 'made');
  expect(syncedDirs(() => createDir(path))).toEqual([dir]);
  expect(statSync(path).isDirectory()).toBe(true);
});

test('createDir refuses an existing directory unless it may exist, and then still syncs the one holding it', () => {
  const dir = tempDir();
  const path = join(dir, 'shared');
  createDir(path);
  expect(() => createDir(path)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
  expect(syncedDirs(() => createDir(path, true))).toEqual([dir]);
});

test('createDir throws when the directory to hold it is missing, even if it may exist', () => {
  const path = join(tempDir(), 'missing', 'made');
  expect(() => createDir(path, true)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
});

test('syncDir syncs a directory, and throws for one that is missing', () => {
  const dir = tempDir();
  expect(() => syncDir(dir)).not.toThrow();
  expect(() => syncDir(join(dir, 'missing'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
});
