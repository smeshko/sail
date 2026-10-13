// Paths and globs: where a path really is, and whether it falls inside a run's roots or matches a glob.
import type { Roots } from './types';

/** The roots a path can resolve into. */
export type RootName = keyof Roots;

/** Turns a glob into a regular expression: `**\/` any number of directories, `**` anything, `*` one segment, `?` one character. */
export function globToRegExp(_glob: string): RegExp {
  return /(?!)/;
}

/** Replaces a leading `$STAGE_OUT` in a glob with the call's output directory, before matching. */
export function expandStageOut(glob: string, _stageOut: string): string {
  return glob;
}

/** Whether a path matches at least one glob. */
export function matchesAny(_path: string, _globs: readonly string[]): boolean {
  return false;
}

/**
 * The absolute, lexically normal path a name resolves to, with symlinks followed through the longest existing
 * ancestor. Null when the name cannot be resolved (a leading `~`).
 */
export function resolveReal(path: string, _cwd: string): string | null {
  return path;
}

/** Which root contains a resolved path, or null when none does. Roots are compared by their real paths. */
export function rootOf(_resolved: string, _roots: Roots): RootName | null {
  return null;
}
