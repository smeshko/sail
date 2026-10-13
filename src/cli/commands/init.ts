// `sail init`: writes a repository's `.sail/` in the directory it is run from.
import { EXIT_OK, type ExitCode } from '../exit-codes';
import type { Io } from '../index';

/** A directory's name as the config's `name`. */
export function slugOf(directory: string): string {
  return directory;
}

/** The designation label a repository named `name` starts with. */
export const labelOf = (name: string): string => name;

/** The sail versions a `.sail/` written by `version` accepts. */
export function rangeOf(version: string): string {
  return version;
}

export function init(_args: unknown, _io: Io): ExitCode {
  return EXIT_OK;
}
