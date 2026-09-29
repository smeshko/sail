// The screen: how the terminal view's lines reach the terminal. It knows nothing of events.
//
// A stub until TASK-002: its signatures are final, and its bodies do nothing.

export type Style = 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'cyan';

/** Plain text, or text in one style or several. */
export type Segment = string | readonly [Style | readonly Style[], string];

export type Line = readonly Segment[];

/** An interactive terminal: its width, read on each draw so a resize is picked up. */
export interface Tty {
  columns(): number;
}

/** Calls `tick` every `ms` until the returned function cancels it. */
export type Every = (ms: number, tick: () => void) => () => void;

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const LIVE_TICK_MS = 100;

/** `text` without escape sequences, and with every other control character but tab as a space. */
export function clean(text: string): string {
  return text;
}

export const every: Every = () => () => undefined;

export interface Screen {
  print(line: Line): void;
  live(text: (() => string) | undefined): void;
  close(): void;
}

export function createScreen(_options: { write(text: string): void; tty?: Tty; every?: Every }): Screen {
  return { print: () => undefined, live: () => undefined, close: () => undefined };
}
