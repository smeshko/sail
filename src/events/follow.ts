// Follows a run's events: replays the file, then delivers what is appended, until the run has ended. A late viewer
// replays, then tails (ADR-0012).
//
// - It polls rather than watching the file: it behaves the same on macOS and Linux, and catches appends made from
//   another process or through a rename.
// - A run has ended once the last event delivered is `run:end` and STATUS isn't `running`. The runtime writes STATUS
//   before `run:end`, and a resume sets it back to `running` before it emits anything, so a `run:end` in the middle of
//   a resumed run's file never ends the follow. A consumer that failed on `run:end` reports after it, and changes
//   nothing.
// - A crashed run keeps STATUS `running` with no process behind it, so it is followed until the signal aborts.
import { readStatus } from '../engine/run-dir';
import { readEventsFrom, START } from './consumers/ndjson';
import type { SailEvent } from './types';

export interface FollowOptions {
  onEvent(event: SailEvent): void;
  signal?: AbortSignal;
  /** How long to wait between reads once caught up. 200 ms by default. */
  pollMs?: number;
}

/** Whether the run may still append: a STATUS that is missing or can't be read counts as running. */
function mayAppend(runDir: string): boolean {
  try {
    return readStatus(runDir).status === 'running';
  } catch {
    return true;
  }
}

/** Waits `ms`, or less when `signal` aborts first. True when it waited the whole time. Leaves no timer behind. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (waited: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      resolve(waited);
    };
    const aborted = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** `'ended'` once the run has ended, `'aborted'` when `signal` aborts, or a line of the file that can't be read. */
export async function followEvents(
  runDir: string,
  { onEvent, signal, pollMs = 200 }: FollowOptions,
): Promise<'ended' | 'aborted' | { refused: string }> {
  let cursor = START;
  let lastWasEnd = false;
  while (true) {
    if (signal?.aborted) return 'aborted';
    const read = readEventsFrom(runDir, cursor);
    if ('refused' in read) return read;
    for (const event of read.events) {
      onEvent(event);
      if (event.type !== 'error:consumer') lastWasEnd = event.type === 'run:end';
    }
    cursor = read.next;
    // Only a read that finds nothing new waits: until then the follow is catching up.
    if (read.events.length > 0) continue;
    if (lastWasEnd && !mayAppend(runDir)) return 'ended';
    if (!(await wait(pollMs, signal))) return 'aborted';
  }
}
