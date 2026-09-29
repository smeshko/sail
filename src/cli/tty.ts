// Whether stdout is an interactive terminal the terminal view may colour and draw a live line in.
//
// A stub until TASK-007: its signature is final, and it always answers plain mode.
import type { Tty } from '../events/consumers/screen';

export function detectTty(
  _stream: { isTTY?: boolean; columns?: number },
  _env: Record<string, string | undefined>,
): Tty | undefined {
  return undefined;
}
