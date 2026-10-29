// A run's control file, `<run dir>/CONTROL`: a request, from outside the run's process, to stop at its next call
// boundary, or end the running call with `stopped now`. It holds a request and a newline:
// - `stopped`, which `sail stop` writes, fails the run: its workspace and lease are released, as for any failed run.
// - `unwatched`, which the watcher writes when the run's workflow is unwatched, suspends it, keeping both.
//
// A stop replaces whatever is there (`requestStop()`), so a stop always wins. An unwatch only creates the file
// (`requestUnwatch()`), so it never writes over a stop, and a stop written after it replaces it. The engine takes the
// file before the intake and before each call (`takeControl()`): it moves the file aside under a name only this process
// uses, reads it, and removes it. So each request acts once: a resumed run never suspends again on an old `unwatched`,
// and a request written after the take is a new file the next boundary sees. A file holding anything else is removed
// and ignored: a request that can't be read stops nothing.
//
// The watcher takes back an `unwatched` a dead run never took before it resumes the run, its workflow watched again
// (`cancelUnwatch()`). It takes only a file that reads `unwatched`, and only a dead run's: a live run's file may be
// replaced by a stop between the read and the take, and nothing writes to a dead run's, since `sail stop` ends one.
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFile } from './durable';

export const CONTROL_FILE = 'CONTROL';

/** What a control file asks of its run: `stopped` fails it, `unwatched` suspends it. */
export type ControlRequest = 'stopped' | 'unwatched';

const REQUESTS: readonly ControlRequest[] = ['stopped', 'unwatched'];

/** A name in `runDir` only this process uses, for a temp file or a taken one. */
const own = (runDir: string, suffix: string) =>
  join(runDir, `${CONTROL_FILE}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.${suffix}`);

/** Asks the run in `runDir` to stop, replacing any request there. */
export function requestStop(runDir: string): void {
  replaceFile(join(runDir, CONTROL_FILE), 'stopped\n', own(runDir, 'tmp'));
}

/** Asks the run to end its running call now, replacing any earlier request. */
export function requestStopNow(runDir: string): void {
  replaceFile(join(runDir, CONTROL_FILE), 'stopped now\n', own(runDir, 'tmp'));
}

/** Reads an immediate stop without taking it: the boundary still consumes the request. */
export function stopNowRequested(runDir: string): boolean {
  try {
    return readFileSync(join(runDir, CONTROL_FILE), 'utf8') === 'stopped now\n';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Asks the run in `runDir` to suspend, unless a request is already there. True when it wrote the request. */
export function requestUnwatch(runDir: string): boolean {
  const tmp = own(runDir, 'tmp');
  writeFileSync(tmp, 'unwatched\n');
  try {
    linkSync(tmp, join(runDir, CONTROL_FILE));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Takes the run's request, once: the request, or undefined when there is none or it can't be read. */
export function takeControl(runDir: string): ControlRequest | undefined {
  const taken = own(runDir, 'taken');
  try {
    renameSync(join(runDir, CONTROL_FILE), taken);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const text = readFileSync(taken, 'utf8');
    return text === 'stopped now\n' ? 'stopped' : REQUESTS.find((request) => text === `${request}\n`);
  } finally {
    rmSync(taken, { force: true });
  }
}

/**
 * Takes back an `unwatched` a dead run never took, and leaves a `stopped` where it is: the file is read first and taken
 * only when it asks to suspend. Only for a dead run, whose file nothing else writes: a stop written into a live run's
 * between the read and the take would be taken with it, and written back only after.
 */
export function cancelUnwatch(runDir: string): void {
  let text: string;
  try {
    text = readFileSync(join(runDir, CONTROL_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (text !== 'unwatched\n') return;
  if (takeControl(runDir) === 'stopped') requestStop(runDir);
}
