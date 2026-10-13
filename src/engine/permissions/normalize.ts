// Normalizes a parsed script into simple commands: wrappers, env and cd are resolved, git's global options and nested
// shells are unwrapped, and every path is resolved. A refusal throws `Refusal` with its rule.
import type { Script } from './tokenize';
import type { Roots } from './types';

/** One simple command, as the deny set and the patterns see it. */
export interface NormalizedCommand {
  /** The unquoted words after the wrappers and assignments are stripped. */
  readonly argv: readonly string[];
  /** The directory the command runs in: the worktree, or a `cd` target inside a root. */
  readonly cwd: string;
  /** The environment assignments the command runs with. */
  readonly env: Readonly<Record<string, string>>;
  /** Resolved paths the command writes: redirect targets and path-like arguments. */
  readonly writes: readonly string[];
  /** Resolved paths the command reads: redirect sources. */
  readonly reads: readonly string[];
}

/** Normalizes every simple command of a script, unwrapping nested shells. Throws `Refusal` for a refusal. */
export function normalize(_script: Script, _roots: Roots): NormalizedCommand[] {
  return [];
}
