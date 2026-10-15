// The watcher's terminal lines: `<HH:MM:SS> <workflow>  <what>`, one per queue event of a watched workflow, per item
// the dispatch settled, per command the watcher rejected and per error, plus a `watch set:` line for the set.
//
// - The time is local unless a time zone is given, as tests pin UTC.
// - Ticket titles, reasons and messages are provider text: each line is cleaned as the terminal view cleans a segment,
//   so a title can't put an escape code or a line break on the watcher's terminal.
// - Colour only on a terminal: the time dim, errors and parked items red. Piped, the lines are plain.
// - Durations read as the terminal view's do (`30.0s`, `5m 0s`).
import type { Tty } from '../events/consumers/screen';
import type { QueueEvent } from '../events/types';
import type { Settled } from './dispatch';

/** One line before it is formatted: when, for which workflow, what, and whether it calls for attention. */
export interface WatchLine {
  at: Date;
  /** Left out for a line about the watcher itself, such as the watch set. */
  workflow?: string;
  text: string;
  alert?: boolean;
}

const STUB: WatchLine = { at: new Date(0), text: '' };

/** The line of a queue event, or undefined when it prints none. `afterError` says the workflow's last poll failed. */
export function queueLine(_event: QueueEvent, _afterError = false): WatchLine | undefined {
  return STUB;
}

/** The line of an item the dispatch settled. A parked item has none: its `queue:parked` says so. */
export function settledLine(_workflow: string, _settled: Settled, _at: Date): WatchLine | undefined {
  return STUB;
}

/** The line of an error: a command the watcher rejected, or anything that went wrong in a tick. */
export function errorLine(_workflow: string | undefined, _error: unknown, _at: Date): WatchLine {
  return STUB;
}

/** The line of the watch set as it is now. */
export function setLine(_workflows: readonly string[], _at: Date): WatchLine {
  return STUB;
}

export interface FormatOptions {
  /** Present when the lines go to an interactive terminal: colour. */
  tty?: Tty;
  /** The time zone the time is shown in: the system's when left out. */
  timeZone?: string;
}

/** Formats each line as `<HH:MM:SS> <workflow>  <text>\n`, cleaned, and coloured only on a terminal. */
export function formatLines(_options: FormatOptions = {}): (line: WatchLine) => string {
  return () => '';
}
