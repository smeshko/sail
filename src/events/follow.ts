// Follows a run's events: replays the file, then delivers what is appended, until the run has ended.
import type { SailEvent } from './types';

export interface FollowOptions {
  onEvent(event: SailEvent): void;
  signal?: AbortSignal;
  /** How long to wait between reads once caught up. 200 ms by default. */
  pollMs?: number;
}

/** `'ended'` once the run has ended, `'aborted'` when `signal` aborts, or a line of the file that can't be read. */
export async function followEvents(
  _runDir: string,
  _options: FollowOptions,
): Promise<'ended' | 'aborted' | { refused: string }> {
  return 'aborted';
}
