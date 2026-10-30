// Where a path really goes: resolved the way the kernel would, symlinks followed and `..` applied after them, then
// placed in the worktree, `$STAGE_IN`, `$STAGE_OUT` or outside, and checked against the step's read or write globs.
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { matchesGlob } from './glob';
import { allow, type DecideContext, type Decision, deny, type Permissions } from './types';

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

/** The writes that go nowhere. */
const SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

/** The roots of `ctx`, `realpath`'d: macOS puts temp directories behind `/var` → `/private/var`. */
export function roots(ctx: DecideContext): Roots {
  return {
    worktree: realpathSync(ctx.worktree),
    stageIn: realpathSync(ctx.stageIn),
    stageOut: realpathSync(ctx.stageOut),
  };
}

/** `text` with `$NAME` and `${NAME}` replaced from `env`. `~` and a variable `env` lacks leave it unresolvable. */
export function expand(text: string, env: Readonly<Record<string, string>>): Resolved {
  if (text.startsWith('~')) return { ok: false, reason: `${text.split('/')[0]} can't be resolved` };
  let missing: string | undefined;
  const path = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, bare) => {
    const name = (braced ?? bare) as string;
    const value = env[name];
    if (value === undefined) missing ??= `$${name}`;
    return value ?? whole;
  });
  return missing === undefined ? { ok: true, path } : { ok: false, reason: `${missing} is not set` };
}

/**
 * The absolute path `path` reaches from `cwd`, as the kernel would resolve it: each component `lstat`ed, a symbolic
 * link replaced by its target even when that doesn't exist, `..` applied to the resolved parent. Below a missing
 * directory the rest is joined as written; a `..` there can't be resolved.
 */
export function resolvePhysical(path: string, cwd: string): Resolved {
  // Never join(): it would apply `..` lexically, before the links it passes are followed.
  const queue = (isAbsolute(path) ? path : `${cwd}/${path}`).split('/').filter((part) => part !== '');
  let current = '/';
  let missing = false;
  let links = 0;
  while (queue.length > 0) {
    const part = queue.shift() as string;
    if (part === '.') continue;
    if (part === '..') {
      if (missing) return { ok: false, reason: `.. below ${current}, which doesn't exist, can't be resolved` };
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    if (missing) {
      current = next;
      continue;
    }
    let link: string | undefined;
    try {
      link = lstatSync(next).isSymbolicLink() ? readlinkSync(next) : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing = true;
    }
    if (link === undefined) {
      current = next;
      continue;
    }
    links++;
    if (links > MAX_LINKS) return { ok: false, reason: `more than ${MAX_LINKS} symbolic links: a loop?` };
    queue.unshift(...link.split('/').filter((piece) => piece !== ''));
    if (isAbsolute(link)) current = '/';
  }
  return { ok: true, path: current };
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** The region `abs` lies in. `$STAGE_IN` is matched first, without case, as it lies beside `$STAGE_OUT`. */
export function place(abs: string, at: Roots): Region {
  if (within(abs.toLowerCase(), at.stageIn.toLowerCase())) return 'stage-in';
  if (within(abs, at.stageOut)) return 'stage-out';
  if (within(abs, at.worktree)) return 'worktree';
  return 'outside';
}

function rootOf(region: Region, at: Roots): string {
  return region === 'stage-in' ? at.stageIn : region === 'stage-out' ? at.stageOut : at.worktree;
}

/** The path relative to its region's root, with a trailing `/` for an existing directory; the root itself is ``. */
function relativeTo(abs: string, root: string): string {
  if (abs === root) return '';
  const rel = abs.slice(root.length + 1);
  try {
    return statSync(abs).isDirectory() ? `${rel}/` : rel;
  } catch {
    return rel;
  }
}

/** The globs that apply in `region`: `$STAGE_OUT/…` and `$STAGE_IN/…` to theirs, the rest to the worktree. */
function globsFor(region: Region, globs: readonly string[]): string[] {
  const prefix = region === 'stage-out' ? '$STAGE_OUT/' : region === 'stage-in' ? '$STAGE_IN/' : undefined;
  if (prefix !== undefined) return globs.filter((g) => g.startsWith(prefix)).map((g) => g.slice(prefix.length));
  return globs.filter((g) => !g.startsWith('$') && !isAbsolute(g));
}

/** Where `path` resolves from `cwd`, or why it can't be resolved. `cwd` must itself lie in the workspace. */
function locate(path: string, ctx: DecideContext, at: Roots, cwd: string | undefined): Resolved {
  const from = resolvePhysical(cwd ?? ctx.worktree, '/');
  if (!from.ok) return from;
  if (place(from.path, at) === 'outside')
    return { ok: false, reason: `the working directory ${cwd} is outside the workspace` };
  const expanded = expand(path, ctx.env);
  if (!expanded.ok) return expanded;
  return resolvePhysical(expanded.path, from.path);
}

function hasGitComponent(rel: string): boolean {
  return rel.split('/').some((part) => part.toLowerCase() === '.git');
}

/** Reads are open in `$STAGE_IN` and `$STAGE_OUT`, and in the worktree where a read glob matches. */
export function checkRead(
  paths: readonly string[],
  permissions: Permissions,
  ctx: DecideContext,
  cwd?: string,
): Decision {
  const at = roots(ctx);
  for (const path of paths) {
    const found = locate(path, ctx, at, cwd);
    if (!found.ok) return deny('read', `read ${path}: ${found.reason}`);
    const region = place(found.path, at);
    if (region === 'stage-in' || region === 'stage-out') continue;
    const said = `read ${path} → ${found.path}`;
    if (region === 'outside') return deny('read', `${said}: outside the workspace, $STAGE_IN and $STAGE_OUT`);
    const rel = relativeTo(found.path, at.worktree);
    if (!matchesGlob(rel, globsFor(region, permissions.read))) {
      return deny('read', `${said}: matches none of the step's read globs`);
    }
  }
  return allow;
}

/** Writes are open in the worktree and `$STAGE_OUT` where a write glob matches; never in `$STAGE_IN` or `.git`. */
export function checkWrite(
  paths: readonly string[],
  permissions: Permissions,
  ctx: DecideContext,
  cwd?: string,
): Decision {
  const at = roots(ctx);
  for (const path of paths) {
    if (SINKS.has(path)) continue;
    const found = locate(path, ctx, at, cwd);
    if (!found.ok) return deny('write', `write ${path}: ${found.reason}`);
    const region = place(found.path, at);
    const said = `write ${path} → ${found.path}`;
    if (region === 'outside') return deny('write', `${said}: outside the workspace and $STAGE_OUT`);
    if (region === 'stage-in') return deny('write', `${said}: $STAGE_IN is the engine's record of the call's inputs`);
    const rel = relativeTo(found.path, rootOf(region, at));
    if (hasGitComponent(rel)) return deny('write', `${said}: nothing under .git is ever written`);
    if (!matchesGlob(rel, globsFor(region, permissions.write))) {
      return deny('write', `${said}: matches none of the step's write globs`);
    }
  }
  return allow;
}

/** Where `path` resolves, when that lies in the worktree, `$STAGE_IN` or `$STAGE_OUT`: for `cd` and git's paths. */
export function insideRoots(path: string, ctx: DecideContext, cwd?: string): Resolved {
  const at = roots(ctx);
  const found = locate(path, ctx, at, cwd);
  if (!found.ok) return found;
  if (place(found.path, at) === 'outside') return { ok: false, reason: `${found.path} is outside the workspace` };
  return found;
}

/** The lexical form of `path` from `cwd`: what `cd -L` hands the kernel. */
export function logical(path: string, cwd: string): string {
  return normalize(isAbsolute(path) ? path : join(cwd, path));
}
