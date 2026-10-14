// The decision for a command: every simple command it would run, found through wrappers, nested shells and
// substitutions (D9), checked against the deny set first, then the step's commands, then where `cd`, git's
// directory options and every redirection lead.
// STUB (tdd-plan): every command is refused. TASK-007 writes the decision.
import type { DecideContext, Decision, Permissions } from './types';

/**
 * The verdict for `command`, run from `cwd` (the worktree when absent): the deny set over every command it would
 * run, then what can't be checked, then the step's commands over each, then `cd` and git's paths, then every
 * redirection's target.
 */
export function decideCommand(
  _command: string,
  _permissions: Permissions,
  _ctx: DecideContext,
  _cwd?: string,
): Decision {
  return { allow: false, rule: 'tools', reason: 'stub' };
}
