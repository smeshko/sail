// A run's control file, `<run dir>/CONTROL`: a request, from outside the run's process, to stop at its next call
// boundary. It holds one word and a newline:
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
// A dispatched run has no run directory until it starts, so a request for it waits in its hand-off file,
// `.sail-runs/<run id>.control`, written like `CONTROL` (`askToSuspend()`, `askToStop()`). The run moves it into
// `CONTROL` right after it makes its directory (`takeHandOff()`), and a writer that finds the directory there once it has
// written does the same, so a request written at either side of the directory's creation is moved in exactly once. The
// watcher deletes a hand-off the run never took when it settles the item (`dropHandOff()`).
//
// The watcher takes back an `unwatched` a dead run never took before it resumes the run, its workflow watched again
// (`cancelUnwatch()`). It takes only a file that reads `unwatched`, and only a dead run's: a live run's file may be
// replaced by a stop between the read and the take, and nothing writes to a dead run's, since `sail stop` ends one.
import { existsSync, linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/** Creates `file` holding an `unwatched` through a temp file in `dir`, unless it exists. True when it wrote it. */
function createUnwatch(file: string, tmp: string): boolean {
  writeFileSync(tmp, 'unwatched\n');
  try {
    linkSync(tmp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Asks the run in `runDir` to suspend, unless a request is already there. True when it wrote the request. */
export function requestUnwatch(runDir: string): boolean {
  return createUnwatch(join(runDir, CONTROL_FILE), own(runDir, 'tmp'));
}

/** Moves `file` aside under `taken`, reads it and removes it: the request, or undefined when none or unreadable. */
function takeFile(file: string, taken: string): ControlRequest | undefined {
  try {
    renameSync(file, taken);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const text = readFileSync(taken, 'utf8');
    return REQUESTS.find((request) => text === `${request}\n`);
  } finally {
    rmSync(taken, { force: true });
  }
}

/** Takes the run's request, once: the request, or undefined when there is none or it can't be read. */
export function takeControl(runDir: string): ControlRequest | undefined {
  return takeFile(join(runDir, CONTROL_FILE), own(runDir, 'taken'));
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

/** Where a dispatched run's request waits until its run directory exists: `.sail-runs/<run id>.control`. */
export const handOffFile = (runsDir: string, runId: string) => join(runsDir, `${runId}.control`);

const handOffName = (runsDir: string, runId: string, suffix: string) =>
  join(runsDir, `${runId}.control.${process.pid}.${Math.random().toString(16).slice(2, 10)}.${suffix}`);

/**
 * Writes a request to the run `runId` in `runsDir`: into `CONTROL` when its directory exists, otherwise into its
 * hand-off. The hand-off is written first and the directory checked after, as the run makes the directory first and
 * takes the hand-off after, so one side sees the other's write.
 */
function ask(runsDir: string, runId: string, request: 'stop' | 'suspend'): boolean {
  const runDir = join(runsDir, runId);
  const write = (): boolean => {
    if (request === 'stop') {
      requestStop(runDir);
      return true;
    }
    return requestUnwatch(runDir);
  };
  if (existsSync(runDir)) {
    takeHandOff(runsDir, runId);
    return write();
  }
  const file = handOffFile(runsDir, runId);
  let wrote = true;
  if (request === 'stop') replaceFile(file, 'stopped\n', handOffName(runsDir, runId, 'tmp'));
  else wrote = createUnwatch(file, handOffName(runsDir, runId, 'tmp'));
  if (existsSync(runDir)) takeHandOff(runsDir, runId);
  return wrote;
}

/** Asks the run `runId` to suspend, unless a request is already waiting. True when it wrote the request. */
export const askToSuspend = (runsDir: string, runId: string): boolean => ask(runsDir, runId, 'suspend');

/** Asks the run `runId` to stop, replacing any request. */
export const askToStop = (runsDir: string, runId: string): void => void ask(runsDir, runId, 'stop');

/** Moves the run's hand-off into its `CONTROL`, once, keeping a stop over an unwatch. Call it once the run directory exists. */
export function takeHandOff(runsDir: string, runId: string): void {
  const request = takeFile(handOffFile(runsDir, runId), handOffName(runsDir, runId, 'taken'));
  if (request === undefined) return;
  const runDir = join(runsDir, runId);
  try {
    if (request === 'stopped') requestStop(runDir);
    else requestUnwatch(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Removes the run's hand-off, a request it never took. */
export function dropHandOff(runsDir: string, runId: string): void {
  rmSync(handOffFile(runsDir, runId), { force: true });
}
