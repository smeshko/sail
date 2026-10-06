import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callPaths,
  createCallDir,
  existingTries,
  isPlainName,
  nextTry,
  RESERVED_NAMES,
  runRelative,
  stageDirName,
} from '../../src/engine/call-dir';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-call-dir-'));
  dirs.push(dir);
  return dir;
}

test('a stage folder is its index, two digits at least, then its name', () => {
  expect(stageDirName(0, 'tests')).toBe('00-tests');
  expect(stageDirName(7, 'publish')).toBe('07-publish');
  expect(stageDirName(123, 'x')).toBe('123-x');
});

test.each([[-1], [1.5], [Number.NaN]])('a stage index of %p is refused', (index) => {
  expect(() => stageDirName(index, 'tests')).toThrow('stage index');
});

test("a call's paths sit in NN-<stage>/call-N/, with $STAGE_IN as in/ inside it", () => {
  expect(callPaths('/r', 3, 'tests', 2)).toEqual({
    dir: '/r/03-tests/call-2',
    stageIn: '/r/03-tests/call-2/in',
    stdout: '/r/03-tests/call-2/stdout.log',
    stderr: '/r/03-tests/call-2/stderr.log',
    result: '/r/03-tests/call-2/result.json',
  });
});

test.each([[0], [-1], [1.5]])('call %p is refused', (call) => {
  expect(() => callPaths('/r', 0, 'tests', call)).toThrow('call');
});

test("a later try's paths sit in call-N/try-M/, and try 1 is call-N/ itself", () => {
  expect(callPaths('/r', 3, 'tests', 2, 1).dir).toBe('/r/03-tests/call-2');
  expect(callPaths('/r', 3, 'tests', 2, 3)).toEqual({
    dir: '/r/03-tests/call-2/try-3',
    stageIn: '/r/03-tests/call-2/try-3/in',
    stdout: '/r/03-tests/call-2/try-3/stdout.log',
    stderr: '/r/03-tests/call-2/try-3/stderr.log',
    result: '/r/03-tests/call-2/try-3/result.json',
  });
});

test.each([[0], [-1], [1.5]])('try %p is refused', (tryNumber) => {
  expect(() => callPaths('/r', 0, 'tests', 1, tryNumber)).toThrow(`try must be a whole number ≥ 1: ${tryNumber}`);
});

test("nextTry numbers a call's tries from what is on disk", () => {
  const runDir = tempDir();
  expect(nextTry(runDir, 3, 'tests', 1)).toBe(1);
  mkdirSync(join(runDir, '03-tests', 'call-1', 'in'), { recursive: true });
  expect(nextTry(runDir, 3, 'tests', 1)).toBe(2);
  mkdirSync(join(runDir, '03-tests', 'call-1', 'try-2'));
  mkdirSync(join(runDir, '03-tests', 'call-1', 'try-3'));
  expect(nextTry(runDir, 3, 'tests', 1)).toBe(4);
  expect(nextTry(runDir, 3, 'tests', 2)).toBe(1);
});

test("a call's later tries are try-2 and up, each once: a directory named otherwise is no try", () => {
  const runDir = tempDir();
  const callDir = join(runDir, '03-tests', 'call-1');
  mkdirSync(join(callDir, 'try-0'), { recursive: true });
  mkdirSync(join(callDir, 'try-1'));
  mkdirSync(join(callDir, 'retry-2'));
  expect(existingTries(runDir, 3, 'tests', 1)).toEqual([1]);
  expect(nextTry(runDir, 3, 'tests', 1)).toBe(2);

  mkdirSync(join(callDir, 'try-10'));
  mkdirSync(join(callDir, 'try-3'));
  mkdirSync(join(callDir, 'try-03'));
  expect(existingTries(runDir, 3, 'tests', 1)).toEqual([1, 3, 10]);
  expect(nextTry(runDir, 3, 'tests', 1)).toBe(11);
  expect(existingTries(runDir, 3, 'tests', 2)).toEqual([]);
});

test('createCallDir creates the call directory and in/, and refuses to reuse one', () => {
  const paths = callPaths(tempDir(), 0, 'tests', 1);
  createCallDir(paths);
  expect(statSync(paths.dir).isDirectory()).toBe(true);
  expect(statSync(paths.stageIn).isDirectory()).toBe(true);
  expect(existsSync(paths.result)).toBe(false);
  expect(() => createCallDir(paths)).toThrow('EEXIST');
});

test('no produced file may take the name of what the engine writes beside it, the prompt and transcript of an agent included', () => {
  expect([...RESERVED_NAMES].sort()).toEqual([
    'in',
    'prompt.md',
    'result.json',
    'session.log',
    'stderr.log',
    'stdout.log',
  ]);
});

test('isPlainName takes a name that stays directly inside a directory', () => {
  for (const name of ['junit.xml', '.hidden', '..x', 'a b']) expect(isPlainName(name)).toBe(true);
  for (const name of ['', '.', '..', '../x', 'a/b', 'a\\b', '/abs']) expect(isPlainName(name)).toBe(false);
});

test('runRelative gives a run-relative POSIX path, as result.json records files', () => {
  const runDir = '/x/.sail-runs/FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
  expect(runRelative(runDir, join(callPaths(runDir, 3, 'tests', 1).dir, 'junit.xml'))).toBe(
    '03-tests/call-1/junit.xml',
  );
});
