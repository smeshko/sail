// How commands print what they found: counts, durations, dollars, tables, and `tsc` diagnostics located relative to
// where the user ran them.
import type { Diagnostic } from '../engine/typecheck';

/** `1 stage`, `2 stages`. */
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * `999ms`, `1.0s`, `1m 0s`, `1h 0m`: the terminal view's durations, rounded as it rounds them, so `sail show` and a
 * run's own output agree. Each unit is chosen after rounding: 59 950 ms is `1m 0s`, never `60.0s`.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

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
