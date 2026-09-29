// events.ndjson: the run's event stream, one JSON line per event, appended and never truncated beyond a torn tail.
//
// - The file is append-only across a resume (ADR-0012): a resumed run continues it from `nextSeq()`. The prototype's
//   consumer truncated it in `init()`.
// - Each line is one `O_APPEND` write with no fsync. A killed process loses nothing, since the kernel has the bytes; a
//   power cut can lose or tear the tail. Events are observability, not resume state, so the journal alone pays for
//   durability.
// - A write that fails keeps its line for the next event's write, which first cuts whatever the failed write left. So
//   a file whose writes recover, say once a full disk has room again, still holds every `seq` in order.
// - Streaming chunks arrive with Epic 07, coalesced into whole events: a chunk never takes a `seq`.
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { createFileOnce } from '../../engine/durable';
import type { Consumer, SailEvent } from '../types';

export const EVENTS_FILE = 'events.ndjson';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Creates the run's empty events file. An existing one throws `EEXIST`. */
export function createEventsFile(runDir: string): void {
  createFileOnce(join(runDir, EVENTS_FILE), '');
}

/**
 * The `seq` a resumed run continues from: 1 for a missing or empty file, else one past the last complete line's. A torn
 * tail is cut first. A last line that can't be read refuses, and leaves the file as it was.
 */
export function nextSeq(runDir: string): number | { refused: string } {
  const path = join(runDir, EVENTS_FILE);
  if (!existsSync(path)) return 1;
  const text = readFileSync(path, 'utf8');
  const end = text.lastIndexOf('\n') + 1;
  const complete = text.slice(0, end).split('\n').slice(0, -1);
  // Only the last complete line is read: the bus numbers events without a gap, so it holds the highest seq.
  let last = 0;
  if (complete.length > 0) {
    const refused = (why: string) => ({
      refused: `${EVENTS_FILE}:${complete.length} can't be read, so the events can't continue: ${why}`,
    });
    let seq: unknown;
    try {
      seq = JSON.parse(complete.at(-1) ?? '').seq;
    } catch (error) {
      return refused(messageOf(error));
    }
    if (!Number.isInteger(seq) || (seq as number) < 1)
      return refused(`its seq is ${JSON.stringify(seq)}, not 1 or more`);
    last = seq as number;
  }
  if (end < text.length) truncateSync(path, Buffer.byteLength(text.slice(0, end)));
  return last + 1;
}

/**
 * The run's events, in file order. A stub until TASK-005: it reads nothing.
 */
export function readEvents(_runDir: string): SailEvent[] {
  return [];
}

/**
 * Appends each event to `events.ndjson` as one line. A write that fails throws, and the bus reports it. Its line waits
 * for the next event's write, which first cuts the file back to its last whole line.
 */
export function ndjsonConsumer(runDir: string): Consumer {
  const path = join(runDir, EVENTS_FILE);
  /** Lines a failed write left out, oldest first. */
  let pending = '';
  /** The file's size up to its last whole line, from its first event on. */
  let size: number | undefined;
  return {
    name: EVENTS_FILE,
    onEvent(event) {
      size ??= statSync(path, { throwIfNoEntry: false })?.size ?? 0;
      const recovering = pending !== '';
      pending += `${JSON.stringify(event)}\n`;
      // A write that failed part way may have left a torn line, which this one would otherwise run into. Only ever
      // cut: truncating a file shorter than `size` would pad it.
      if (recovering && (statSync(path, { throwIfNoEntry: false })?.size ?? 0) > size) truncateSync(path, size);
      appendFileSync(path, pending);
      size += Buffer.byteLength(pending);
      pending = '';
    },
  };
}
