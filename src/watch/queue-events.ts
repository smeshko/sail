// A watched workflow's queue event stream: `.sail-runs/queue/<workflow>/events.ndjson`, one JSON line per event.
//
// - It has no bus: the queue store is its one writer, and nothing in-process consumes it until 13.2's terminal lines.
//   So `emit` stamps and appends, and a write that fails throws to the store's caller.
// - Its envelope has no `runId`: a poll or a parked item belongs to the workflow, not to any run (design.md §8).
// - It continues across restarts the way a resumed run's stream does, through `nextSeq()`, which cuts a torn tail and
//   refuses a last line it can't read.
// - An append that fails may leave part of its line, as on a full disk. The next event first cuts the file back to its
//   last whole line, as the run's stream does, so the line it writes is never run into a torn one, and the stream
//   reopens. The failed event's `seq` goes to the next event, so none is skipped.
import { mkdirSync, statSync, truncateSync } from 'node:fs';
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
  const sizeOf = () => statSync(path, { throwIfNoEntry: false })?.size ?? 0;
  let seq = first;
  /** The file's size up to its last whole line. */
  let size = sizeOf();
  let failed = false;
  return {
    emit(event) {
      const stamped = { seq, ts: now().toISOString(), ...event } as QueueEvent;
      const line = JSON.stringify(stamped);
      // Only ever cut: truncating a file shorter than `size` would pad it.
      if (failed && sizeOf() > size) truncateSync(path, size);
      failed = true;
      appendLine(path, line);
      failed = false;
      size += Buffer.byteLength(line) + 1;
      seq += 1;
      return stamped;
    },
  };
}
