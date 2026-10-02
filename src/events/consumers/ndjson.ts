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
// - `readEventsFrom()` reads it from a cursor, a complete line at a time, so a viewer can replay the file and then follow
//   it. A torn tail waits for the next read. `readEvents()` reads the same lines, and keeps only the valid events.
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
} from 'node:fs';
import { join } from 'node:path';
import { createFileOnce } from '../../engine/durable';
import { validateDocument } from '../../engine/schemas';
import type { Consumer, SailEvent } from '../types';

export const EVENTS_FILE = 'events.ndjson';

/** Where a read of the events file stopped: the byte just past its last complete line, and that line's number. */
export interface EventCursor {
  offset: number;
  line: number;
}

/** The start of the file. */
export const START: EventCursor = { offset: 0, line: 0 };

/** The complete lines from `from` on, as events, with the cursor after them. A line that can't be read refuses. */
export function readEventsFrom(
  runDir: string,
  from: EventCursor = START,
): { events: SailEvent[]; next: EventCursor } | { refused: string } {
  const path = join(runDir, EVENTS_FILE);
  if (!existsSync(path)) return { events: [], next: from };
  const { lines, end } = completeLines(path, from.offset);
  const events: SailEvent[] = [];
  for (const line of lines) {
    const event = parseEvent(line);
    if (typeof event === 'string') {
      return { refused: `${EVENTS_FILE}:${from.line + events.length + 1} can't be read: ${event}` };
    }
    events.push(event);
  }
  return { events, next: { offset: end, line: from.line + events.length } };
}

/** The complete lines of `path` from byte `offset` on, and the offset just past the last of them. */
function completeLines(path: string, offset: number): { lines: string[]; end: number } {
  const tail = readTail(path, offset);
  const lines: string[] = [];
  let start = 0;
  // Split on the byte, before decoding: a multi-byte character never holds 0x0A, so a line cut inside one is simply
  // incomplete, and waits for the next read.
  for (let end = tail.indexOf(0x0a); end !== -1; end = tail.indexOf(0x0a, start)) {
    lines.push(tail.subarray(start, end).toString('utf8'));
    start = end + 1;
  }
  return { lines, end: offset + start };
}

/** The bytes of `path` from `offset` to its end, read through a descriptor so a follower never rereads the file. */
function readTail(path: string, offset: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const tail = Buffer.alloc(Math.max(0, fstatSync(fd).size - offset));
    return tail.subarray(0, readSync(fd, tail, 0, tail.length, offset));
  } finally {
    closeSync(fd);
  }
}

/** One line as an event, or why it isn't one. Lines aren't checked against the schema: validateRunDir() does that. */
function parseEvent(line: string): SailEvent | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return messageOf(error);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'it is not a JSON object';
  const { seq, type } = value as Record<string, unknown>;
  if (!Number.isInteger(seq) || (seq as number) < 1) return `its seq is ${JSON.stringify(seq)}, not 1 or more`;
  if (typeof type !== 'string') return `its type is ${JSON.stringify(type)}, not a string`;
  return value as SailEvent;
}

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
 * The run's events, in file order: every complete line that is a valid `sail.event.v1` event, so a reader can trust
 * each one's fields. A torn tail and any other line are skipped, and a missing file gives none. It never truncates:
 * `nextSeq()` alone cuts a torn tail, and only on a resume that proceeds.
 */
export function readEvents(runDir: string): SailEvent[] {
  const path = join(runDir, EVENTS_FILE);
  if (!existsSync(path)) return [];
  return completeLines(path, 0).lines.flatMap((line) => {
    const event = parseEvent(line);
    return typeof event !== 'string' && validateDocument('sail.event.v1', event).length === 0 ? [event] : [];
  });
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
