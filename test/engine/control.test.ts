// A run's control file (DECISIONS D2): a stop replaces any request, and the engine's take
// returns each request once and leaves nothing behind.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askToStop,
  CONTROL_FILE,
  handOffFile,
  holdRun,
  isHeld,
  releaseHold,
  requestStop,
  requestStopNow,
  requestSuspend,
  stopNowRequested,
  suspendRequested,
  takeControl,
  takeHandOff,
} from '../../src/engine/control';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An empty run directory. */
function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-control-'));
  dirs.push(dir);
  return dir;
}

/** What the run directory holds: each file, with its text. */
const held = (dir: string) => readdirSync(dir).map((name) => `${name}: ${readFileSync(join(dir, name), 'utf8')}`);

test('an immediate stop is peeked without taking, taken as stopped, and replaceable by plain stop', () => {
  const dir = runDir();
  expect(stopNowRequested(dir)).toBe(false);
  requestStopNow(dir);
  expect(held(dir)).toEqual(['CONTROL: stopped now\n']);
  expect(stopNowRequested(dir)).toBe(true);
  expect(held(dir)).toEqual(['CONTROL: stopped now\n']);
  expect(takeControl(dir)).toBe('stopped');
  expect(stopNowRequested(dir)).toBe(false);
  requestStopNow(dir);
  requestStop(dir);
  expect([held(dir), stopNowRequested(dir)]).toEqual([['CONTROL: stopped\n'], false]);
});

test('a stop replaces any request in the control file, a plain one a stop now', () => {
  const dir = runDir();
  const steps = [requestStopNow(dir), held(dir), requestStop(dir), held(dir)];
  expect(steps).toEqual([undefined, ['CONTROL: stopped now\n'], undefined, ['CONTROL: stopped\n']]);
});

test('a take returns the request once and leaves nothing behind, and a file holding anything else, an unwatched included, is removed and ignored', () => {
  const dir = runDir();
  requestStop(dir);
  const stop = [takeControl(dir), takeControl(dir), held(dir)];
  const unreadable = ['pause\n', 'stopped', 'unwatched\n', 'unwatched\nstopped\n'].map((text) => {
    writeFileSync(join(dir, CONTROL_FILE), text);
    return [takeControl(dir), held(dir)];
  });
  expect({ stop, unreadable }).toEqual({
    stop: ['stopped', undefined, []],
    unreadable: [
      [undefined, []],
      [undefined, []],
      [undefined, []],
      [undefined, []],
    ],
  });
});

// The hand-off file: a request for a dispatched run that has no run directory yet.

const ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';

/** A runs directory, with the run directory made when `exists` says so. */
function runsWith(exists: boolean): { runs: string; run: string } {
  const runs = runDir();
  const run = join(runs, ID);
  if (exists) mkdirSync(run);
  return { runs, run };
}

const handOff = (runs: string) =>
  existsSync(handOffFile(runs, ID)) ? readFileSync(handOffFile(runs, ID), 'utf8') : undefined;
const control = (run: string) =>
  existsSync(join(run, CONTROL_FILE)) ? readFileSync(join(run, CONTROL_FILE), 'utf8') : undefined;

test('asking a run with no directory to stop writes the hand-off, and asking again replaces it', () => {
  const { runs } = runsWith(false);
  askToStop(runs, ID);
  const first = handOff(runs);
  askToStop(runs, ID);
  expect([first, handOff(runs), readdirSync(runs)]).toEqual(['stopped\n', 'stopped\n', [`${ID}.control`]]);
});

test('asking a run whose directory exists to stop writes CONTROL and no hand-off', () => {
  const { runs, run } = runsWith(true);
  askToStop(runs, ID);
  expect([control(run), handOff(runs)]).toEqual(['stopped\n', undefined]);
});

test('taking the hand-off moves a stop into CONTROL over whatever is there, and removes the hand-off', () => {
  const over = runsWith(true);
  writeFileSync(join(over.run, CONTROL_FILE), 'unwatched\n');
  writeHandOff(over.runs, 'stopped\n');
  takeHandOff(over.runs, ID);
  expect([control(over.run), handOff(over.runs)]).toEqual(['stopped\n', undefined]);
});

/** Writes a hand-off whole, as it stood before the run directory existed. */
function writeHandOff(runs: string, text: string): void {
  writeFileSync(handOffFile(runs, ID), text);
}

test('taking a junk hand-off removes it and writes nothing, and taking none is a no-op', () => {
  const { runs, run } = runsWith(true);
  takeHandOff(runs, ID);
  const none = [control(run), readdirSync(runs)];
  writeHandOff(runs, 'pause\n');
  takeHandOff(runs, ID);
  expect([none, control(run), readdirSync(runs)]).toEqual([[undefined, [ID]], undefined, [ID]]);
});

test('a stop written once the directory exists is moved into CONTROL by the writer, so none is lost to the run taking the hand-off first', () => {
  const { runs, run } = runsWith(false);
  writeHandOff(runs, 'stopped\n');
  mkdirSync(run);
  askToStop(runs, ID);
  expect([control(run), handOff(runs), readdirSync(runs)]).toEqual(['stopped\n', undefined, [ID]]);
});

test('a hand-off written before the directory is taken into CONTROL by the run', () => {
  const { runs, run } = runsWith(false);
  askToStop(runs, ID);
  mkdirSync(run);
  takeHandOff(runs, ID);
  expect([control(run), handOff(runs)]).toEqual(['stopped\n', undefined]);
});

test('a suspend is peeked without taking, taken as suspended, and replaced by a later stop', () => {
  const dir = runDir();
  expect(suspendRequested(dir)).toBe(false);
  requestSuspend(dir);
  expect([held(dir), suspendRequested(dir), stopNowRequested(dir)]).toEqual([['CONTROL: suspended\n'], true, false]);
  expect([takeControl(dir), held(dir), suspendRequested(dir)]).toEqual(['suspended', [], false]);
  requestSuspend(dir);
  requestStop(dir);
  expect([held(dir), suspendRequested(dir)]).toEqual([['CONTROL: stopped\n'], false]);
});

test('a hold is written, seen, and removed, and removing none is harmless', () => {
  const dir = runDir();
  expect(isHeld(dir)).toBe(false);
  holdRun(dir);
  expect([isHeld(dir), held(dir)]).toEqual([true, ['HOLD: held\n']]);
  releaseHold(dir);
  releaseHold(dir);
  expect([isHeld(dir), held(dir)]).toEqual([false, []]);
});
