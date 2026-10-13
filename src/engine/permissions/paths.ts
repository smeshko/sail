// Paths and globs: where a path really is, and whether it falls inside a run's roots or matches a glob.
import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { Roots } from './types';

/** The roots a path can resolve into. */
export type RootName = keyof Roots;

const ROOT_NAMES: readonly RootName[] = ['worktree', 'stageOut', 'stageIn'];
const STAGE_OUT = '$STAGE_OUT';
// The symlinks one path may follow before it is treated as unresolvable, so a loop cannot run forever.
const MAX_LINKS = 40;

/** Turns a glob into a regular expression: `**\/` any number of directories, `**` anything, `*` one segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      source += '.*';
      i += 1;
    } else if (glob[i] === '*') {
      source += '[^/]*';
    } else if (glob[i] === '?') {
      source += '[^/]';
    } else {
      source += (glob[i] ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** Replaces a leading `$STAGE_OUT` in a glob with the call's output directory, before matching. */
export function expandStageOut(glob: string, stageOut: string): string {
  return glob.startsWith(STAGE_OUT) ? stageOut + glob.slice(STAGE_OUT.length) : glob;
}

/** Whether a path matches at least one glob. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/**
 * The physical path a name resolves to: each symlink is followed where it occurs, so a `..` after one climbs from its
 * target, as the filesystem does. Null when the name cannot be resolved (a leading `~`, or too many links).
 */
export function resolveReal(path: string, cwd: string): string | null {
  if (path.startsWith('~')) return null;
  return physical(path.startsWith('/') ? path : `${cwd}/${path}`);
}

/**
 * Which root contains a resolved path, or null when none does. Roots are compared by their real paths, and the deepest
 * containing root wins, so a binding nested inside the output directory is not the output.
 */
export function rootOf(resolved: string, roots: Roots): RootName | null {
  let best: RootName | null = null;
  let bestLength = -1;
  for (const name of ROOT_NAMES) {
    const root = physical(roots[name]) ?? roots[name];
    const inside = resolved === root || resolved.startsWith(root + sep);
    if (inside && root.length > bestLength) {
      best = name;
      bestLength = root.length;
    }
  }
  return best;
}

/** An absolute path walked one component at a time, following each symbolic link where it sits. */
function physical(absolute: string): string | null {
  let queue = absolute.split('/').filter((part) => part !== '' && part !== '.');
  let current = '/';
  let links = 0;
  while (queue.length > 0) {
    const [part = '', ...rest] = queue;
    queue = rest;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, part);
    const target = symlinkTarget(candidate);
    if (target === null) {
      current = candidate;
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) return null;
    if (target.startsWith('/')) current = '/';
    queue = [...target.split('/').filter((piece) => piece !== '' && piece !== '.'), ...queue];
  }
  return current;
}

/** The target a path names when it is a symbolic link, dangling or not, and null for anything else. */
function symlinkTarget(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return null;
  }
}
