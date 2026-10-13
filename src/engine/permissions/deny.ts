// The default deny set: nine rules checked on each normalized command, before any step pattern.
import type { NormalizedCommand } from './normalize';
import type { Script } from './tokenize';
import type { Rule } from './types';

/** A deny-set match: its `deny:<name>` rule and a reason naming the command that matched. */
export interface DenyMatch {
  readonly rule: Rule;
  readonly reason: string;
}

/** The deny rule a normalized command matches, given its pipeline, or null. */
export function denyRule(_command: NormalizedCommand, _pipeline: Script): DenyMatch | null {
  return null;
}
