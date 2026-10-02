// runCaptured(): runs `sail <argv>` in process from `cwd`, capturing what it prints. It runs in plain mode unless the
// test hands it a `tty`. fakeInterrupts() stands in for Ctrl-C, through the `io.onInterrupt` a command registers its
// handler with. normaliseDurations() makes a terminal view's timings comparable.
import type { ExitCode } from '../../src/cli/exit-codes';
import { type Io, run } from '../../src/cli/index';
import type { Tty } from '../../src/events/consumers/screen';

export interface Captured {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

export interface CaptureOptions {
  /** Handed to the command as `io.onInterrupt`, for a test to interrupt it. */
  onInterrupt?: Io['onInterrupt'];
  /** Handed to the command as `io.tty`, as if stdout were an interactive terminal. */
  tty?: Tty;
  /** Handed to the command as `io.env`: the environment it runs in, in place of the process's. */
  env?: Io['env'];
}

/** `text` with each duration the terminal view prints, such as `850ms`, `2.5s`, `1m 11s` or `2h 2m`, as `<t>`. */
export function normaliseDurations(text: string): string {
  return text.replace(/\b(\d+h \d+m|\d+m \d+s|\d+\.\ds|\d+ms)\b/g, '<t>');
}

export async function runCaptured(
  argv: readonly string[],
  cwd: string = process.cwd(),
  options: CaptureOptions = {},
): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    cwd,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...(options.onInterrupt === undefined ? {} : { onInterrupt: options.onInterrupt }),
    ...(options.tty === undefined ? {} : { tty: options.tty }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

/** A fake `io.onInterrupt`: `interrupt()` calls every handler registered, and the counts show what was registered. */
export function fakeInterrupts(): Required<Pick<CaptureOptions, 'onInterrupt'>> & {
  interrupt(): void;
  readonly registered: number;
  readonly unregistered: number;
} {
  const handlers: (() => void)[] = [];
  let unregistered = 0;
  return {
    onInterrupt: (handler) => {
      handlers.push(handler);
      return () => {
        unregistered++;
      };
    },
    interrupt: () => {
      for (const handler of handlers) handler();
    },
    get registered() {
      return handlers.length;
    },
    get unregistered() {
      return unregistered;
    },
  };
}
