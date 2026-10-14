// A watched workflow's queue event stream: `.sail-runs/queue/<workflow>/events.ndjson`, one JSON line per event.
// Stubbed for queue-store-and-polling: TASK-002 writes it.
import type { NewQueueEvent, QueueEvent } from '../events/types';

export interface QueueStream {
  /** Stamps `seq` and `ts` on the event, appends it as one line, and returns it as written. */
  emit(event: NewQueueEvent): QueueEvent;
}

/** Opens the stream in `dir`, creating it, from the `seq` after its last line. A last line it can't read refuses. */
export function openQueueStream(_dir: string, _now: () => Date): QueueStream | { refused: string } {
  return { emit: (event) => ({ seq: 0, ts: '', ...event }) as QueueEvent };
}
