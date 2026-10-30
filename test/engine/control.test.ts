// A run's control file (DECISIONS D2): a stop replaces any request, an unwatch only creates one, and the engine's take
// returns each request once and leaves nothing behind.
import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askToStop,
  askToSuspend,
  CONTROL_FILE,
  cancelUnwatch,
  dropHandOff,
  handOffFile,
  requestStop,
  requestStopNow,
  requestUnwatch,
  stopNowRequested,
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

test('an unwatch request is written only where none is, and a stop replaces any request, never the other way round', () => {
  const dir = runDir();
  const steps = [
    requestUnwatch(dir),
    held(dir),
    requestUnwatch(dir),
    held(dir),
    requestStop(dir),
    held(dir),
    requestUnwatch(dir),
    held(dir),
  ];
  expect(steps).toEqual([
    true,
    ['CONTROL: unwatched\n'],
    false,
    ['CONTROL: unwatched\n'],
    undefined,
    ['CONTROL: stopped\n'],
    false,
    ['CONTROL: stopped\n'],
  ]);
});

test('a take returns the request once and leaves nothing behind, and a file holding anything else is removed and ignored', () => {
  const dir = runDir();
  requestStop(dir);
  const stop = [takeControl(dir), takeControl(dir), held(dir)];
  requestUnwatch(dir);
  const unwatch = [takeControl(dir), held(dir)];
  const unreadable = ['pause\n', 'stopped', 'unwatched\nstopped\n'].map((text) => {
    writeFileSync(join(dir, CONTROL_FILE), text);
    return [takeControl(dir), held(dir)];
  });
  expect({ stop, unwatch, unreadable }).toEqual({
    stop: ['stopped', undefined, []],
    unwatch: ['unwatched', []],
    unreadable: [
      [undefined, []],
      [undefined, []],
      [undefined, []],
    ],
  });
});

test('cancelling an unwatch removes an unwatched and keeps a stopped', () => {
  const dir = runDir();
  requestUnwatch(dir);
  cancelUnwatch(dir);
  const afterUnwatch = held(dir);
  requestStop(dir);
  cancelUnwatch(dir);
  expect([afterUnwatch, held(dir)]).toEqual([[], ['CONTROL: stopped\n']]);
});

test('cancelling an unwatch never takes a stop out of the file, even for a moment: the stop stays the same file (review R1-4)', () => {
  const dir = runDir();
  requestStop(dir);
  const before = statSync(join(dir, CONTROL_FILE)).ino;
  cancelUnwatch(dir);
  expect([statSync(join(dir, CONTROL_FILE)).ino, held(dir)]).toEqual([before, ['CONTROL: stopped\n']]);
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

test('asking a run with no directory to suspend writes the hand-off once, and a stop replaces it, never the other way round', () => {
  const { runs } = runsWith(false);
  const steps = [askToSuspend(runs, ID), handOff(runs), askToSuspend(runs, ID)];
  askToStop(runs, ID);
  steps.push(handOff(runs), askToSuspend(runs, ID), handOff(runs));
  expect([...steps, readdirSync(runs)]).toEqual([
    true,
    'unwatched\n',
    false,
    'stopped\n',
    false,
    'stopped\n',
    [`${ID}.control`],
  ]);
});

test('asking a run whose directory exists writes CONTROL and no hand-off', () => {
  const { runs, run } = runsWith(true);
  const wrote = askToSuspend(runs, ID);
  const afterSuspend = [control(run), handOff(runs)];
  askToStop(runs, ID);
  expect([wrote, afterSuspend, control(run), handOff(runs)]).toEqual([
    true,
    ['unwatched\n', undefined],
    'stopped\n',
    undefined,
  ]);
});

test('taking the hand-off moves a stop over an unwatched CONTROL and leaves a stopped CONTROL to an unwatch, and removes the hand-off', () => {
  const stopOverUnwatch = runsWith(true);
  requestUnwatch(stopOverUnwatch.run);
  writeHandOff(stopOverUnwatch.runs, 'stopped\n');
  takeHandOff(stopOverUnwatch.runs, ID);

  const unwatchUnderStop = runsWith(true);
  requestStop(unwatchUnderStop.run);
  writeHandOff(unwatchUnderStop.runs, 'unwatched\n');
  takeHandOff(unwatchUnderStop.runs, ID);

  expect({
    stop: [control(stopOverUnwatch.run), handOff(stopOverUnwatch.runs)],
    unwatch: [control(unwatchUnderStop.run), handOff(unwatchUnderStop.runs)],
  }).toEqual({ stop: ['stopped\n', undefined], unwatch: ['stopped\n', undefined] });
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

test('a request written once the directory exists is moved into CONTROL by the writer, so none is lost to the run taking the hand-off first', () => {
  const { runs, run } = runsWith(false);
  askToSuspend(runs, ID);
  mkdirSync(run);
  askToStop(runs, ID);
  expect([control(run), handOff(runs), readdirSync(runs)]).toEqual(['stopped\n', undefined, [ID]]);
});

test('a hand-off written before the directory is taken into CONTROL by the run, whichever request it holds', () => {
  const { runs, run } = runsWith(false);
  askToSuspend(runs, ID);
  mkdirSync(run);
  takeHandOff(runs, ID);
  expect([control(run), handOff(runs)]).toEqual(['unwatched\n', undefined]);
});

test('taking a hand-off for a run directory that was removed meanwhile leaves nothing behind and does not throw', () => {
  const { runs } = runsWith(false);
  askToSuspend(runs, ID);
  takeHandOff(runs, ID);
  expect(readdirSync(runs)).toEqual([]);
});

test('dropping a hand-off removes it, and is a no-op when there is none', () => {
  const { runs } = runsWith(false);
  askToStop(runs, ID);
  dropHandOff(runs, ID);
  const dropped = readdirSync(runs);
  dropHandOff(runs, ID);
  expect([dropped, readdirSync(runs)]).toEqual([[], []]);
});
