// Where a path really goes: resolved the way the kernel would, symlinks followed and `..` applied after them, then
// placed in the worktree, `$STAGE_IN`, `$STAGE_OUT` or outside, and checked against the step's read or write globs.
// STUB (tdd-plan): nothing resolves and every check refuses. TASK-005 writes them.
import type { DecideContext, Decision, Permissions } from './types';

export type Region = 'worktree' | 'stage-in' | 'stage-out' | 'outside';

/** The three roots, each `realpath`'d. */
export interface Roots {
  readonly worktree: string;
  readonly stageIn: string;
  readonly stageOut: string;
}

export type Resolved = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

/** How many symbolic links one path may pass through. */
export const MAX_LINKS = 40;

const REFUSED: Decision = { allow: false, rule: 'tools', reason: 'stub' };

/** The roots of `ctx`, `realpath`'d: macOS puts temp directories behind `/var` → `/private/var`. */
export function roots(ctx: DecideContext): Roots {
  return { worktree: ctx.worktree, stageIn: ctx.stageIn, stageOut: ctx.stageOut };
}

/** `text` with `$NAME` and `${NAME}` replaced from `env`. `~` and a variable `env` lacks leave it unresolvable. */
export function expand(_text: string, _env: Readonly<Record<string, string>>): Resolved {
  return { ok: false, reason: 'stub' };
}

/**
 * The absolute path `path` reaches from `cwd`, as the kernel would resolve it: each component `lstat`ed, a symbolic
 * link replaced by its target even when that doesn't exist, `..` applied to the resolved parent. Below a missing
 * directory the rest is joined as written; a `..` there can't be resolved.
 */
export function resolvePhysical(_path: string, _cwd: string): Resolved {
  return { ok: false, reason: 'stub' };
}

/** The region `abs` lies in. `$STAGE_IN` is matched first, without case, since it lies inside `$STAGE_OUT`. */
export function place(_abs: string, _at: Roots): Region {
  return 'outside';
}

/** Reads are open in `$STAGE_IN` and `$STAGE_OUT`, and in the worktree where a read glob matches. */
export function checkRead(
  _paths: readonly string[],
  _permissions: Permissions,
  _ctx: DecideContext,
  _cwd?: string,
): Decision {
  return REFUSED;
}

/** Writes are open in the worktree and `$STAGE_OUT` where a write glob matches; never in `$STAGE_IN` or `.git`. */
export function checkWrite(
  _paths: readonly string[],
  _permissions: Permissions,
  _ctx: DecideContext,
  _cwd?: string,
): Decision {
  return REFUSED;
}

/** Where `path` resolves, when that lies in the worktree, `$STAGE_IN` or `$STAGE_OUT`: for `cd` and git's paths. */
export function insideRoots(_path: string, _ctx: DecideContext, _cwd?: string): Resolved {
  return { ok: false, reason: 'stub' };
}

/** The lexical form of `path` from `cwd`: what `cd -L` hands the kernel. */
export function logical(path: string, _cwd: string): string {
  return path;
}
