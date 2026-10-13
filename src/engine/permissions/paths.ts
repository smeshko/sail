// Paths and globs: where a path really is, and whether it falls inside a run's roots or matches a glob.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
 * The absolute, lexically normal path a name resolves to, with symlinks followed through the longest existing
 * ancestor. Null when the name cannot be resolved (a leading `~`).
 */
export function resolveReal(path: string, cwd: string): string | null {
  if (path.startsWith('~')) return null;
  return realise(resolve(cwd, path), 0);
}

/** Which root contains a resolved path, or null when none does. Roots are compared by their real paths. */
export function rootOf(resolved: string, roots: Roots): RootName | null {
  for (const name of ROOT_NAMES) {
    const root = realise(roots[name], 0) ?? roots[name];
    if (resolved === root || resolved.startsWith(root + sep)) return name;
  }
  return null;
}

/** An absolute path with its longest existing ancestor realpath'd, and a dangling symlink followed to its target. */
function realise(absolute: string, links: number): string | null {
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest);
    } catch {
      const target = symlinkTarget(existing);
      if (target !== null) {
        if (links >= MAX_LINKS) return null;
        return realise(resolve(dirname(existing), target, ...rest), links + 1);
      }
    }
    const parent = dirname(existing);
    if (parent === existing) return join(existing, ...rest);
    rest.unshift(basename(existing));
    existing = parent;
  }
}

/** The target a path names when it is a symbolic link, dangling or not, and null for anything else. */
function symlinkTarget(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return null;
  }
}
