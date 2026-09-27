// Finds a repository's `.sail/` and checks its config, `project.yaml`: what every command that reads `.sail/` does
// first.
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type SchemaIssue, validateProjectFile } from './schemas';

export type SailDir = { root: string; dir: string } | { refused: string };

/**
 * Finds the nearest `.sail/` from `cwd` up to the git root, the first directory holding a `.git` entry. A `.git` file,
 * as in a worktree, counts. The search stops at the git root because `~/.sail/` is sail's machine-level directory
 * (branch leases, the watcher registry), and a repository inside the home directory must never take it for its own.
 * No git is spawned.
 */
export function findSailDir(cwd: string): SailDir {
  let found: string | undefined;
  let at = cwd;
  while (true) {
    const candidate = join(at, '.sail');
    if (found === undefined && statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true) {
      found = candidate;
    }
    if (existsSync(join(at, '.git'))) {
      if (found === undefined) return { refused: `no .sail/ between ${cwd} and the git root ${at}` };
      return { root: at, dir: found };
    }
    const parent = dirname(at);
    if (parent === at) return { refused: `not inside a git repository: ${cwd}` };
    at = parent;
  }
}

/**
 * Every way `<dir>/project.yaml` is missing or breaks `sail.project.v1`. The caller sets each issue's `file`, relative
 * to where the user ran the command.
 */
export function projectIssues(dir: string): SchemaIssue[] {
  const path = join(dir, 'project.yaml');
  if (!existsSync(path)) return [{ schema: 'sail.project.v1', path: '/', message: 'is missing' }];
  return validateProjectFile(path);
}
