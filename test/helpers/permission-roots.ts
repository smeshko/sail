// The roots a permission test decides against, built inside a withTempRepo() repository: the repository is the worktree,
// its call's output and bindings sit beside it, and two more directories stand for the clone's own checkout and for
// some unrelated place outside the run.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Roots } from '../../src/engine/permissions/types';
import type { TempRepo } from './temp-repo';

export interface PermissionRoots {
  readonly roots: Roots;
  /** The temp directory above the worktree, which holds every directory this helper makes. */
  readonly base: string;
  /** The clone's own checkout: outside the run's worktree, and never a root. */
  readonly clone: string;
  /** A directory outside every root. */
  readonly elsewhere: string;
}

export function permissionRoots(repo: TempRepo): PermissionRoots {
  const base = dirname(repo.dir);
  const stageOut = join(base, 'call', 'out');
  const stageIn = join(base, 'call', 'in');
  const clone = join(base, 'clone');
  const elsewhere = join(base, 'elsewhere');
  for (const dir of [stageOut, stageIn, clone, elsewhere]) mkdirSync(dir, { recursive: true });
  return { roots: { worktree: repo.dir, stageOut, stageIn }, base, clone, elsewhere };
}
