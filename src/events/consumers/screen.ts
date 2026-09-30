// The screen: how the terminal view's lines reach the terminal. It knows nothing of events.
//
// A terminal and plain mode print the same text, so a terminal, a pipe and a CI log read alike and one golden view
// per verbosity covers both. A terminal adds only SGR colour and the live line.
//
// The live line is the one line a terminal redraws in place. Every printed line clears it first and draws it again
// below, and it is cut to fit one column short of the width, so it never wraps and a clear always removes it whole.
//
// Every segment is cleaned before it is written: a script's coloured output or a message holding `\r` can't put an
// escape code into plain mode or break the live line.

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

const SGR: Record<Style, number> = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36 };
const RESET = '\x1b[0m';
/** Back to the line's start, then erase the whole line. */
const CLEAR_LINE = '\r\x1b[2K';

// CSI is ESC [, parameter and intermediate bytes, then a final byte from @ to ~. OSC is ESC ], ended by BEL or ESC \.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// C0 but tab, DEL, and C1: some UTF-8 terminals act on U+009B as CSI and on U+0085 as a newline.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROLS = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

/** `text` without escape sequences, and with every other control character but tab as a space. */
export function clean(text: string): string {
  return text.replace(ESCAPES, '').replace(CONTROLS, ' ');
}

export const every: Every = (ms, tick) => {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
};

export interface Screen {
  print(line: Line): void;
  live(text: (() => string) | undefined): void;
  close(): void;
}

function styled(style: Style | readonly Style[], text: string): string {
  const codes = (typeof style === 'string' ? [style] : style).map((one) => SGR[one]).join(';');
  return `\x1b[${codes}m${text}${RESET}`;
}

/** `text` cut to `width` code points, its last kept character replaced by `…` when cut. */
function fit(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  return width < 1 ? '' : `${chars.slice(0, width - 1).join('')}…`;
}

export function createScreen(options: { write(text: string): void; tty?: Tty; every?: Every }): Screen {
  const { write, tty } = options;
  let text: (() => string) | undefined;
  let cancel: (() => void) | undefined;
  let frame = 0;

  const render = (line: Line): string =>
    line
      .map((segment) => {
        if (typeof segment === 'string') return clean(segment);
        const [style, raw] = segment;
        return tty === undefined ? clean(raw) : styled(style, clean(raw));
      })
      .join('');

  /** The live line as drawn: cleared, then the spinner frame, a space and the text, fitting `columns − 1`. */
  const drawn = (tty: Tty, text: () => string): string => {
    const spinner = SPINNER[frame] as string;
    return `${CLEAR_LINE}${styled('cyan', spinner)} ${styled('dim', fit(clean(text()), tty.columns() - 3))}`;
  };

  const live = (next: (() => string) | undefined): void => {
    if (tty === undefined) return;
    if (next === undefined) {
      if (text !== undefined) write(CLEAR_LINE);
      text = undefined;
      cancel?.();
      cancel = undefined;
      return;
    }
    text = next;
    cancel ??= (options.every ?? every)(LIVE_TICK_MS, () => {
      if (text === undefined) return;
      frame = (frame + 1) % SPINNER.length;
      write(drawn(tty, text));
    });
    write(drawn(tty, text));
  };

  return {
    print(line) {
      if (tty === undefined || text === undefined) {
        write(`${render(line)}\n`);
        return;
      }
      write(`${CLEAR_LINE}${render(line)}\n${drawn(tty, text)}`);
    },
    live,
    close: () => live(undefined),
  };
}
