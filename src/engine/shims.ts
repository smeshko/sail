// The folder of programs sail puts first on the PATH of a step's shell, and the file a Claude Code session sources.
import { delimiter, join } from 'node:path';

/** The `mktemp` shim's folder: a folder of its own, so `bin/sail` isn't put on an agent session's PATH. */
export const SHIMS_DIR = join(import.meta.dir, '..', '..', 'bin', 'shims');

/** The shell file that puts `SHIMS_DIR` (named by `SAIL_SHIMS`) first on the PATH again, in a login shell. */
export const SESSION_ENV_FILE = join(import.meta.dir, '..', '..', 'bin', 'session-env.sh');

/** `path` with `SHIMS_DIR` first, once; `fallback` stands in for a `path` that is undefined or empty. */
export function shimsFirst(path: string | undefined, fallback = '/usr/bin:/bin'): string {
  const base = path === undefined || path === '' ? fallback : path;
  return base === SHIMS_DIR || base.startsWith(`${SHIMS_DIR}${delimiter}`) ? base : `${SHIMS_DIR}${delimiter}${base}`;
}
