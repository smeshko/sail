// A run's control file (DECISIONS D2): a stop replaces any request, an unwatch only creates one, and the engine's take
// returns each request once and leaves nothing behind.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_FILE, cancelUnwatch, requestStop, requestUnwatch, takeControl } from '../../src/engine/control';

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
