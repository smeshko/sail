// The terminal consumer: the event stream as the terminal view, at a verbosity.
//
// A stub until TASK-003: its signatures are final, and it prints nothing.
import type { Consumer, SailEvent } from '../types';
import type { Every, Tty } from './screen';

export const VERBOSITIES = ['quiet', 'normal', 'verbose', 'trace'] as const;
export type Verbosity = (typeof VERBOSITIES)[number];

/** A duration as the terminal view prints it: `850ms`, `2.5s`, `1m 11s`, `2h 2m`. */
export function formatDuration(_ms: number): string {
  return '';
}

/** A size as the terminal view prints it: `622 B`, `1.0 KB`, `2.5 MB`. */
export function formatSize(_bytes: number): string {
  return '';
}

export interface TerminalOptions {
  verbosity: Verbosity;
  write(text: string): void;
  /** Present in an interactive terminal: colour and the live line. */
  tty?: Tty;
  /** Absolute: a tail is read from `<runsDir>/<runId>/<dirname(resultPath)>/`. */
  runsDir: string;
  /** The final block's `run` row. */
  shownRunsDir: string;
  /** The run's earlier events, on a resume: they print nothing. */
  prior?: readonly SailEvent[];
  now?: () => number;
  every?: Every;
}

export interface TerminalConsumer extends Consumer {
  close(): void;
}

export function terminalConsumer(_options: TerminalOptions): TerminalConsumer {
  return { name: 'terminal', onEvent: () => undefined, close: () => undefined };
}
