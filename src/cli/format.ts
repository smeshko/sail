// How commands print what they found: counts, durations, dollars, tables, and `tsc` diagnostics located relative to
// where the user ran them.
import type { Diagnostic } from '../engine/typecheck';

// The terminal view's durations, so `sail show`'s table and a run's own output agree.
export { formatDuration } from '../events/consumers/terminal';

/** `1 stage`, `2 stages`. */
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** `$1.35`: dollars to the cent. */
export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`;

/** Rows as lines: each column as wide as its widest cell, two spaces apart, and no line ending in whitespace. */
export function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [i, cell] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, cell.length);
  }
  return rows.map((row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd(),
  );
}

/** `file:line:column  code  message`, leaving out what the diagnostic doesn't carry. `at` relativises the file. */
export function formatDiagnostic({ file, line, column, code, message }: Diagnostic, at: (path: string) => string) {
  return `${file === undefined ? '' : `${at(file)}:${line}:${column}  `}${code === '' ? '' : `${code}  `}${message}`;
}
