// runCaptured(): runs `sail <argv>` in process from `cwd`, capturing what it prints. fakeInterrupts() stands in for
// Ctrl-C, through the `io.onInterrupt` a command registers its handler with.
import type { ExitCode } from '../../src/cli/exit-codes';
import { type Io, run } from '../../src/cli/index';

export interface Captured {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

export interface CaptureOptions {
  /** Handed to the command as `io.onInterrupt`, for a test to interrupt it. */
  onInterrupt?: Io['onInterrupt'];
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
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

/** A fake `io.onInterrupt`: `interrupt()` calls every handler registered, and the counts show what was registered. */
export function fakeInterrupts(): Required<CaptureOptions> & {
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
