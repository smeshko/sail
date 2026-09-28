// events.ndjson: the run's event stream, one JSON line per event, appended and never truncated beyond a torn tail.
//
// - The file is append-only across a resume (ADR-0012): a resumed run continues it from `nextSeq()`. The prototype's
//   consumer truncated it in `init()`.
// - Each line is one `O_APPEND` write with no fsync. A killed process loses nothing, since the kernel has the bytes; a
//   power cut can lose or tear the tail. Events are observability, not resume state, so the journal alone pays for
//   durability.
// - Streaming chunks arrive with Epic 07, coalesced into whole events: a chunk never takes a `seq`.
import { appendFileSync, existsSync, readFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { createFileOnce } from '../../engine/durable';
import type { Consumer } from '../types';

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

/** Appends each event to `events.ndjson` as one line. A write that fails throws, and the bus reports it. */
export function ndjsonConsumer(runDir: string): Consumer {
  const path = join(runDir, EVENTS_FILE);
  return {
    name: EVENTS_FILE,
    onEvent(event) {
      appendFileSync(path, `${JSON.stringify(event)}\n`);
    },
  };
}
