// Whether stdout is an interactive terminal the terminal view may colour and draw a live line in. Anything else is
// plain mode: a pipe, a CI log, `NO_COLOR` set to anything but empty (no-color.org), or `TERM=dumb`.
import type { Tty } from '../events/consumers/screen';

export function detectTty(
  stream: { isTTY?: boolean; columns?: number },
  env: Record<string, string | undefined>,
): Tty | undefined {
  const colour = (env.NO_COLOR ?? '') === '' && env.TERM !== 'dumb';
  // The width is read on each call, so a resized terminal is picked up. A pseudo-terminal with no size reports 0: that
  // is no width known, not a width the live line could fit in.
  return stream.isTTY === true && colour ? { columns: () => stream.columns || 80 } : undefined;
}
