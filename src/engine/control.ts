// A run's control file, `<run dir>/CONTROL`: a request to stop at the run's next call boundary. Stub: nothing is
// written or taken yet.

export const CONTROL_FILE = 'CONTROL';

/** What a control file asks of its run: `stopped` fails it, `unwatched` suspends it. */
export type ControlRequest = 'stopped' | 'unwatched';

/** Asks the run in `runDir` to stop, replacing any request there. */
export function requestStop(_runDir: string): void {}

/** Asks the run in `runDir` to suspend, unless a request is already there. True when it wrote the request. */
export function requestUnwatch(_runDir: string): boolean {
  return false;
}

/** Takes the run's request, once: the request, or undefined when there is none or it can't be read. */
export function takeControl(_runDir: string): ControlRequest | undefined {
  return undefined;
}

/** Takes back an `unwatched` the run never reached, and leaves a `stopped` where it is. */
export function cancelUnwatch(_runDir: string): void {}
