// The watcher's terminal lines: `<HH:MM:SS> <workflow>  <what>`, one per queue event of a watched workflow, per item
// the dispatch settled, per command the watcher rejected and per error, plus a `watch set:` line for the set.
//
// - The time is local unless a time zone is given, as tests pin UTC.
// - Ticket titles, reasons and messages are provider text: each line is cleaned as the terminal view cleans a segment,
//   so a title can't put an escape code or a line break on the watcher's terminal.
// - Colour only on a terminal: the time dim, errors and parked items red. Piped, the lines are plain.
// - Durations read as the terminal view's do (`30.0s`, `5m 0s`).
import { createScreen, type Line, type Tty } from '../events/consumers/screen';
import { formatDuration } from '../events/consumers/terminal';
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

/** The ticket key of a dedup key: `ticket:FAKE-1` is `FAKE-1`. */
const keyOf = (dedupKey: string) => dedupKey.replace(/^ticket:/, '');

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** What `event` says: its line, or nothing for a poll that found nothing new, unless it follows a failed poll. */
function textOf(event: QueueEvent, afterError: boolean): { text: string; alert?: boolean } | undefined {
  switch (event.type) {
    case 'watch:added':
      return {
        text: `watching: label ${event.label}, every ${formatDuration(event.everyMs)}, at most ${event.maxConcurrentRuns} at once`,
      };
    case 'watch:removed':
      return { text: 'unwatched' };
    case 'queue:polled':
      if (event.found === 0 && event.added === 0 && !afterError) return undefined;
      return { text: `polled ${event.label}: ${event.found} found, ${event.added} queued` };
    case 'queue:item_added':
      return { text: `${event.source.ticketKey} queued: ${event.title}` };
    case 'queue:dispatched':
      return {
        text: `${keyOf(event.dedupKey)} dispatched as run ${event.run}, attempt ${event.attempt}, pid ${event.pid}`,
      };
    case 'queue:skipped_leased':
      return { text: `${keyOf(event.dedupKey)} waits: its branch ${event.branch} is leased by run ${event.heldBy}` };
    case 'queue:dropped':
      return { text: `${keyOf(event.dedupKey)} dropped: ${event.reason}` };
    case 'queue:parked':
      return {
        text: `${keyOf(event.dedupKey)} parked after ${plural(event.attempts, 'attempt')}: ${event.reason}`,
        alert: true,
      };
    case 'queue:error': {
      const code = event.code === undefined ? '' : ` ${event.code}`;
      const next = event.paused ? 'polling paused' : `next poll in ${formatDuration(event.retryInMs ?? 0)}`;
      return { text: `error: ${event.adapter}${code}: ${event.message}; ${next}`, alert: true };
    }
    case 'run:adopted':
    case 'run:resumed':
    case 'queue:requeued':
      return undefined;
    default: {
      const unknown: never = event;
      return unknown;
    }
  }
}

/** The line of a queue event, or undefined when it prints none. `afterError` says the workflow's last poll failed. */
export function queueLine(event: QueueEvent, afterError = false): WatchLine | undefined {
  const said = textOf(event, afterError);
  return said === undefined ? undefined : { at: new Date(event.ts), workflow: event.workflow, ...said };
}

/** The line of an item the dispatch settled. A parked item has none: its `queue:parked` says so. */
export function settledLine(workflow: string, settled: Settled, at: Date): WatchLine | undefined {
  const { ticketKey, runId } = settled;
  if (settled.outcome === 'done') return { at, workflow, text: `${ticketKey} done: run ${runId} completed` };
  if (settled.outcome === 'parked') return undefined;
  const due = settled.retryAt === undefined ? 0 : Math.max(0, Date.parse(settled.retryAt) - at.getTime());
  return { at, workflow, text: `${ticketKey} failed: ${settled.reason}; due again in ${formatDuration(due)}` };
}

/** The line of an error: a command the watcher rejected, or anything that went wrong in a tick. */
export function errorLine(workflow: string | undefined, error: unknown, at: Date): WatchLine {
  const message = error instanceof Error ? error.message : String(error);
  return { at, ...(workflow === undefined ? {} : { workflow }), text: `error: ${message}`, alert: true };
}

/** The line of the watch set as it is now. */
export function setLine(workflows: readonly string[], at: Date): WatchLine {
  const text = workflows.length === 0 ? 'watch set: empty; the watcher stops' : `watch set: ${workflows.join(', ')}`;
  return { at, text };
}

export interface FormatOptions {
  /** Present when the lines go to an interactive terminal: colour. */
  tty?: Tty;
  /** The time zone the time is shown in: the system's when left out. */
  timeZone?: string;
}

/** Formats each line as `<HH:MM:SS> <workflow>  <text>\n`, cleaned, and coloured only on a terminal. */
export function formatLines(options: FormatOptions = {}): (line: WatchLine) => string {
  const clock = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  return (line) => {
    let out = '';
    const screen = createScreen({
      write: (text) => {
        out += text;
      },
      ...(options.tty === undefined ? {} : { tty: options.tty }),
    });
    const segments: Line = [
      ['dim', clock.format(line.at)],
      line.workflow === undefined ? ' ' : ` ${line.workflow}  `,
      line.alert ? ['red', line.text] : line.text,
    ];
    screen.print(segments);
    return out;
  };
}
