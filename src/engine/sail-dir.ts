// Finds a repository's `.sail/` and checks its config, `project.yaml`: what every command that reads `.sail/` does
// first.
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type SchemaIssue, validateProjectFile } from './schemas';

export type SailDir = { root: string; dir: string } | { refused: string };

/**
 * The git root of `cwd`: the first directory from it upwards that holds a `.git` entry, or undefined outside any
 * repository. A `.git` file, as in a worktree, counts. No git is spawned.
 */
export function findGitRoot(cwd: string): string | undefined {
  let at = cwd;
  while (!existsSync(join(at, '.git'))) {
    const parent = dirname(at);
    if (parent === at) return undefined;
    at = parent;
  }
  return at;
}

/**
 * Finds the nearest `.sail/` from `cwd` up to the git root. The search stops at the git root because `~/.sail/` is
 * sail's machine-level directory (branch leases, the watcher registry), and a repository inside the home directory
 * must never take it for its own.
 */
export function findSailDir(cwd: string): SailDir {
  const root = findGitRoot(cwd);
  if (root === undefined) return { refused: `not inside a git repository: ${cwd}` };
  for (let at = cwd; ; at = dirname(at)) {
    const candidate = join(at, '.sail');
    if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true) return { root, dir: candidate };
    if (at === root) return { refused: `no .sail/ between ${cwd} and the git root ${root}` };
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
