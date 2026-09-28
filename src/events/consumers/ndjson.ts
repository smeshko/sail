// events.ndjson: the run's event stream, one JSON line per event, appended and never truncated beyond a torn tail.
import type { Consumer } from '../types';

export const EVENTS_FILE = 'events.ndjson';

/** Creates the run's empty events file. An existing one throws `EEXIST`. */
// biome-ignore lint/correctness/noUnusedFunctionParameters: a stub until TASK-003 creates the file
export function createEventsFile(runDir: string): void {}

/**
 * The `seq` a resumed run continues from: 1 for a missing or empty file, else one past the last complete line's. A torn
 * tail is cut first. A last line that can't be read refuses.
 */
// biome-ignore lint/correctness/noUnusedFunctionParameters: a stub until TASK-003 reads the file
export function nextSeq(runDir: string): number | { refused: string } {
  return 0;
}

/** Appends each event to `events.ndjson` as one line. A write that fails throws, and the bus reports it. */
// biome-ignore lint/correctness/noUnusedFunctionParameters: a stub until TASK-003 writes the file
export function ndjsonConsumer(runDir: string): Consumer {
  return { name: EVENTS_FILE, onEvent() {} };
}
