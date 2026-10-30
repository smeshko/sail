import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callPaths,
  createCallDir,
  existingStepTries,
  existingTries,
  isPlainName,
  nextStepTry,
  nextTry,
  runRelative,
  stageDirName,
  stepPaths,
} from '../../src/engine/call-dir';
import { syncedDirs } from '../helpers/synced-dirs';

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
    out: '/r/03-tests/call-2/out',
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
    out: '/r/03-tests/call-2/try-3/out',
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

test('isPlainName takes a name that stays directly inside a directory', () => {
  for (const name of ['junit.xml', '.hidden', '..x', 'a b']) expect(isPlainName(name)).toBe(true);
  for (const name of ['', '.', '..', '../x', 'a/b', 'a\\b', '/abs']) expect(isPlainName(name)).toBe(false);
});

test('runRelative gives a run-relative POSIX path, as result.json records files', () => {
  const runDir = '/x/.sail-runs/FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
  expect(runRelative(runDir, join(callPaths(runDir, 3, 'tests', 1).out, 'junit.xml'))).toBe(
    '03-tests/call-1/out/junit.xml',
  );
});

test('createCallDir leaves in/ out when told to, for a first try and a durable later one, and still refuses to reuse the directory', () => {
  const dir = tempDir();
  const first = callPaths(dir, 0, 'intake', 1);
  createCallDir(first, { stageIn: false });
  expect(readdirSync(first.dir)).toEqual(['out']);
  expect(() => createCallDir(first, { stageIn: false })).toThrow();

  const second = callPaths(dir, 0, 'intake', 1, 2);
  createCallDir(second, { durable: true, stageIn: false });
  expect(readdirSync(second.dir)).toEqual(['out']);
  expect(readdirSync(first.dir).sort()).toEqual(['out', 'try-2']);
  // Left out, the option keeps in/: a step's call still gets its $STAGE_IN.
  const step = callPaths(dir, 1, 'spec', 1);
  createCallDir(step);
  expect(readdirSync(step.dir).sort()).toEqual(['in', 'out']);
});

test("a step's paths sit in call-N/steps/<i>-<step>/, a later try's in try-M/ below them, and its $STAGE_OUT is call-N/out/", () => {
  expect(stepPaths('/r', 5, 'publish', 1, 1, 'describe')).toEqual({
    dir: '/r/05-publish/call-1/steps/1-describe',
    out: '/r/05-publish/call-1/out',
    stageIn: '/r/05-publish/call-1/steps/1-describe/in',
    stdout: '/r/05-publish/call-1/steps/1-describe/stdout.log',
    stderr: '/r/05-publish/call-1/steps/1-describe/stderr.log',
    result: '/r/05-publish/call-1/steps/1-describe/result.json',
  });
  expect(stepPaths('/r', 5, 'publish', 2, 2, 'open', 3)).toEqual({
    dir: '/r/05-publish/call-2/steps/2-open/try-3',
    out: '/r/05-publish/call-2/out',
    stageIn: '/r/05-publish/call-2/steps/2-open/try-3/in',
    stdout: '/r/05-publish/call-2/steps/2-open/try-3/stdout.log',
    stderr: '/r/05-publish/call-2/steps/2-open/try-3/stderr.log',
    result: '/r/05-publish/call-2/steps/2-open/try-3/result.json',
  });
});

test("a step's tries are numbered from its own directory: none before it exists, then try-2 and up, each once", () => {
  const runDir = tempDir();
  const stepDir = join(runDir, '05-publish', 'call-1', 'steps', '2-open');
  // The call's own later tries are no step's.
  mkdirSync(join(runDir, '05-publish', 'call-1', 'try-2'), { recursive: true });
  expect([
    existingStepTries(runDir, 5, 'publish', 1, 2, 'open'),
    nextStepTry(runDir, 5, 'publish', 1, 2, 'open'),
  ]).toEqual([[], 1]);
  mkdirSync(join(stepDir, 'in'), { recursive: true });
  mkdirSync(join(stepDir, 'try-3'));
  mkdirSync(join(stepDir, 'try-x'));
  expect(existingStepTries(runDir, 5, 'publish', 1, 2, 'open')).toEqual([1, 3]);
  expect(nextStepTry(runDir, 5, 'publish', 1, 2, 'open')).toBe(4);
  expect(nextStepTry(runDir, 5, 'publish', 1, 1, 'describe')).toBe(1);
});

test("createCallDir makes a step's directory and in/ inside its call's $STAGE_OUT, which the step before it may have made, and refuses to reuse the step's", () => {
  const runDir = tempDir();
  const describe = stepPaths(runDir, 5, 'publish', 1, 1, 'describe');
  createCallDir(describe);
  expect(readdirSync(join(runDir, '05-publish', 'call-1')).sort()).toEqual(['out', 'steps']);
  expect(readdirSync(describe.dir)).toEqual(['in']);
  const open = stepPaths(runDir, 5, 'publish', 1, 2, 'open');
  createCallDir(open);
  expect(readdirSync(join(runDir, '05-publish', 'call-1', 'steps')).sort()).toEqual(['1-describe', '2-open']);
  expect(readdirSync(open.dir)).toEqual(['in']);
  expect(() => createCallDir(open)).toThrow('EEXIST');
});

test("a durable step directory is synced into each directory it was made in, from the stage's down", () => {
  const runDir = tempDir();
  const describe = stepPaths(runDir, 5, 'publish', 1, 1, 'describe');
  const call = join(runDir, '05-publish', 'call-1');
  expect(syncedDirs(() => createCallDir(describe, { durable: true }))).toEqual([
    runDir,
    join(runDir, '05-publish'),
    call,
    join(call, 'steps'),
    describe.dir,
    call,
  ]);
  const retry = stepPaths(runDir, 5, 'publish', 1, 1, 'describe', 2);
  expect(syncedDirs(() => createCallDir(retry, { durable: true }))).toEqual([describe.dir, retry.dir]);
  expect(readdirSync(retry.dir)).toEqual(['in']);
});
