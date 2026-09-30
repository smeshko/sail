// How commands print what they found: counts, and `tsc` diagnostics located relative to where the user ran them.
import type { Diagnostic } from '../engine/typecheck';

/** `1 stage`, `2 stages`. */
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** `999ms`, `1.0s`, `1m 0s`, `1h 0m`: the terminal view's durations. */
export const formatDuration = (_ms: number): string => '';

/** `$1.35`. */
export const formatUsd = (_usd: number): string => '';

/** Rows as lines: each column as wide as its widest cell, two spaces apart, and no line ending in whitespace. */
export const table = (_rows: readonly (readonly string[])[]): string[] => [];

/** `file:line:column  code  message`, leaving out what the diagnostic doesn't carry. `at` relativises the file. */
export function formatDiagnostic({ file, line, column, code, message }: Diagnostic, at: (path: string) => string) {
  return `${file === undefined ? '' : `${at(file)}:${line}:${column}  `}${code === '' ? '' : `${code}  `}${message}`;
}
