// A run's control file, `<run dir>/CONTROL`: a request, from outside the run's process, to stop at its next call
// boundary, or end the running call with `stopped now`. It holds a request and a newline:
// - `stopped`, which `sail stop` writes, fails the run: its workspace and lease are released, as for any failed run.
// - `suspended`, which `sail stop --suspend` writes, ends the running call at once and suspends the run `interrupted`,
//   keeping its workspace and lease (`requestSuspend()`). It comes with the run's hold: a `HOLD` file in the run directory
//   (`holdRun()`), which the watcher honours by never resuming the run. `sail resume` removes it (`releaseHold()`).
//
// A stop replaces whatever is there (`requestStop()`). The engine takes the file before the intake and before each call
// (`takeControl()`): it moves the file aside under a name only this process uses, reads it, and removes it. So each
// request acts once, and a request written after the take is a new file the next boundary sees. A file holding anything
// else, an `unwatched` an older sail wrote included, is removed and ignored: a request that can't be read stops nothing.
//
// A dispatched run has no run directory until it starts, so a request for it waits in its hand-off file,
// `.sail-runs/<run id>.control`, written like `CONTROL` (`askToStop()`). The run moves it into
// `CONTROL` right after it makes its directory (`takeHandOff()`), and a writer that finds the directory there once it has
// written does the same, so a request written at either side of the directory's creation is moved in exactly once. The
// watcher deletes a hand-off the run never took when it settles the item (`dropHandOff()`). A start refused once its
// directory exists gives a stop back to the hand-off before it removes the directory (`returnStop()`), so a stop sent to
// a start that is then refused is still there for the watcher, which parks the item (`handOffStops()`).

import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFile } from './durable';

export const CONTROL_FILE = 'CONTROL';

export const HOLD_FILE = 'HOLD';

/** What a control file asks of its run: `stopped` fails it, `suspended` suspends it. */
export type ControlRequest = 'stopped' | 'suspended';

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

/** Asks the run to end its running call now and suspend, replacing any earlier request. */
export function requestSuspend(runDir: string): void {
  replaceFile(join(runDir, CONTROL_FILE), 'suspended\n', own(runDir, 'tmp'));
}

/** Reads a suspend request without taking it: the boundary still consumes the request. */
export function suspendRequested(runDir: string): boolean {
  try {
    return readFileSync(join(runDir, CONTROL_FILE), 'utf8') === 'suspended\n';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Marks the run in `runDir` held: the watcher leaves it to a person. */
export function holdRun(runDir: string): void {
  replaceFile(join(runDir, HOLD_FILE), 'held\n', own(runDir, 'hold'));
}

/** Whether the run in `runDir` is held. */
export function isHeld(runDir: string): boolean {
  return existsSync(join(runDir, HOLD_FILE));
}

/** Removes the run's hold, if it has one. */
export function releaseHold(runDir: string): void {
  rmSync(join(runDir, HOLD_FILE), { force: true });
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
    if (text === 'suspended\n') return 'suspended';
    return text === 'stopped\n' || text === 'stopped now\n' ? 'stopped' : undefined;
  } finally {
    rmSync(taken, { force: true });
  }
}

/** Takes the run's request, once: the request, or undefined when there is none or it can't be read. */
export function takeControl(runDir: string): ControlRequest | undefined {
  return takeFile(join(runDir, CONTROL_FILE), own(runDir, 'taken'));
}

/** Where a dispatched run's request waits until its run directory exists: `.sail-runs/<run id>.control`. */
export const handOffFile = (runsDir: string, runId: string) => join(runsDir, `${runId}.control`);

const handOffName = (runsDir: string, runId: string, suffix: string) =>
  join(runsDir, `${runId}.control.${process.pid}.${Math.random().toString(16).slice(2, 10)}.${suffix}`);

/**
 * Writes a stop to the run `runId` in `runsDir`: into `CONTROL` when its directory exists, otherwise into its
 * hand-off. The hand-off is written first and the directory checked after, as the run makes the directory first and
 * takes the hand-off after, so one side sees the other's write.
 */
function ask(runsDir: string, runId: string): void {
  const runDir = join(runsDir, runId);
  if (existsSync(runDir)) {
    try {
      takeHandOff(runsDir, runId);
      requestStop(runDir);
      return;
    } catch (error) {
      // The directory went, as a refused start removes it: the request waits in the hand-off instead.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  replaceFile(handOffFile(runsDir, runId), 'stopped\n', handOffName(runsDir, runId, 'tmp'));
  if (existsSync(runDir)) takeHandOff(runsDir, runId);
}

/** Asks the run `runId` to stop, replacing any request. */
export const askToStop = (runsDir: string, runId: string): void => ask(runsDir, runId);

/** Moves the run's hand-off into its `CONTROL`, once. Call it once the run directory exists. */
export function takeHandOff(runsDir: string, runId: string): void {
  const request = takeFile(handOffFile(runsDir, runId), handOffName(runsDir, runId, 'taken'));
  if (request === undefined) return;
  const runDir = join(runsDir, runId);
  try {
    requestStop(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Gives a stop the run took back to its hand-off, as its start is refused and its run directory is about to go: the
 * watcher finds it there and parks the item rather than retrying it. Anything else in `CONTROL` goes with the directory.
 */
export function returnStop(runsDir: string, runId: string): void {
  let text: string;
  try {
    text = readFileSync(join(runsDir, runId, CONTROL_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (text === 'stopped\n') replaceFile(handOffFile(runsDir, runId), text, handOffName(runsDir, runId, 'tmp'));
}

/** Whether the run's hand-off asks it to stop: a stop sent to a start that was refused before it took it. */
export function handOffStops(runsDir: string, runId: string): boolean {
  try {
    return readFileSync(handOffFile(runsDir, runId), 'utf8') === 'stopped\n';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Removes the run's hand-off, a request it never took. */
export function dropHandOff(runsDir: string, runId: string): void {
  rmSync(handOffFile(runsDir, runId), { force: true });
}
