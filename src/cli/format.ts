// How commands print what they found: counts, and `tsc` diagnostics located relative to where the user ran them.
import type { Diagnostic } from '../engine/typecheck';

/** `1 stage`, `2 stages`. */
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** `file:line:column  code  message`, leaving out what the diagnostic doesn't carry. `at` relativises the file. */
export function formatDiagnostic({ file, line, column, code, message }: Diagnostic, at: (path: string) => string) {
  return `${file === undefined ? '' : `${at(file)}:${line}:${column}  `}${code === '' ? '' : `${code}  `}${message}`;
}
