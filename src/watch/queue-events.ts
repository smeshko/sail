// A watched workflow's queue event stream: `.sail-runs/queue/<workflow>/events.ndjson`, one JSON line per event.
//
// - It has no bus: the queue store is its one writer, and nothing in-process consumes it until 13.2's terminal lines.
//   So `emit` stamps and appends, and a write that fails throws to the store's caller.
// - Its envelope has no `runId`: a poll or a parked item belongs to the workflow, not to any run (design.md §8).
// - It continues across restarts the way a resumed run's stream does, through `nextSeq()`, which cuts a torn tail and
//   refuses a last line it can't read.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendLine } from '../engine/durable';
import { EVENTS_FILE, nextSeq } from '../events/consumers/ndjson';
import type { NewQueueEvent, QueueEvent } from '../events/types';

export interface QueueStream {
  /** Stamps `seq` and `ts` on the event, appends it as one line, and returns it as written. */
  emit(event: NewQueueEvent): QueueEvent;
}

/** Opens the stream in `dir`, creating it, from the `seq` after its last line. A last line it can't read refuses. */
export function openQueueStream(dir: string, now: () => Date): QueueStream | { refused: string } {
  mkdirSync(dir, { recursive: true });
  const first = nextSeq(dir);
  if (typeof first !== 'number') return first;
  const path = join(dir, EVENTS_FILE);
  let seq = first;
  return {
    emit(event) {
      const stamped = { seq, ts: now().toISOString(), ...event } as QueueEvent;
      appendLine(path, JSON.stringify(stamped));
      seq += 1;
      return stamped;
    },
  };
}
