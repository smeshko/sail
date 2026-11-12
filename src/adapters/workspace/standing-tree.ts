// The git side of standing workspaces: leasing one and checking a run's commit out in it in place, releasing it, and
// reopening it for a resume. The lease itself, and where a standing workspace lives, are `standing.ts`.
//
// An in-place checkout keeps what git ignores, which is the point: tracked files go back to the commit, untracked files
// that are not ignored are removed (`clean -ffd`, never `-x` or `-X`), and the build caches stay. The adapter does not
// vouch for them: a stale incremental build is the repository's own gate's to handle.
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PortError } from '../../ports/errors';
import type { Workspace } from '../../ports/types';
import type { RunRef } from '../../ports/workspace';
import { addDetached, type GitResult, gitSync, keepHead, reopenWorktree } from './git';
import {
  dropStanding,
  heldByRun,
  readStanding,
  type StandingLease,
  standingDir,
  standingOf,
  takeStanding,
} from './standing';

type Env = Readonly<Record<string, string>> | undefined;

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

/**
 * The state a rebase, `am`, cherry-pick, revert or bisect left unfinished in a worktree's own git directory. A per-run
 * worktree threw it away with the worktree; a standing one keeps it, so it is removed before the next run's checkout.
 * Removing it moves no ref: an unfinished rebase has not moved its branch yet.
 */
const UNFINISHED = [
  'rebase-merge',
  'rebase-apply',
  'sequencer',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_START',
  'BISECT_LOG',
  'BISECT_TERMS',
  'BISECT_EXPECTED_REV',
  'BISECT_ANCESTORS_OK',
  'BISECT_NAMES',
  'BISECT_HEAD',
  'BISECT_FIRST_PARENT',
];

/** Removes what an unfinished rebase, `am`, cherry-pick, revert or bisect left in the worktree at `path`. */
function clearUnfinished(path: string, env: Env): void {
  const gitDir = gitSync(path, ['rev-parse', '--absolute-git-dir'], env);
  if (gitDir.code !== 0) {
    throw new PortError('workspace', 'create', 'unavailable', `${path}: git rev-parse failed: ${gitDir.stderr}`);
  }
  const dir = gitDir.stdout.trim();
  for (const name of UNFINISHED) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch (error) {
      throw new PortError('workspace', 'create', 'unavailable', `${path}: ${(error as Error).message}`);
    }
  }
}

/**
 * Checks `sha` out in the worktree at `path`, detached, with the clone's hooks off: tracked files as committed, a merge
 * left half done cleared, a rebase, `am`, cherry-pick, revert or bisect left unfinished cleared, untracked files that are
 * not ignored removed, ignored files kept. A failure is `unavailable`, with git's own words.
 */
export function checkOutInPlace(path: string, sha: string, env?: Env): void {
  clearUnfinished(path, env);
  const steps = [
    ['checkout', '--force', '--detach', sha],
    ['reset', '--hard', sha],
    ['clean', '-ffd'],
  ];
  for (const step of steps) {
    const done = gitSync(path, [...NO_HOOKS, ...step], env);
    if (done.code !== 0) {
      throw new PortError('workspace', 'create', 'unavailable', `${path}: git ${step[0]} failed: ${done.stderr}`);
    }
  }
}

/** Whether `path` is a worktree of its own, not a directory inside another checkout. */
function isWorktree(path: string, env: Env): boolean {
  const top = gitSync(path, ['rev-parse', '--show-toplevel'], env);
  return top.code === 0 && top.stdout.trim() === realpathSync(path);
}

/** The standing workspaces' parent: the directory that holds the run directories. */
const runsDirOf = (run: { runDir: string }): string => dirname(resolve(run.runDir));

/**
 * Gives `run` the first free standing workspace of its workflow, its commit `sha` checked out. It walks `n` from 0
 * below `run.maxConcurrentRuns ?? 1`, takes the first lease it can, keeps the head of a stale holder it took over at
 * that run's run ref first, then adds the worktree (`--force`, so one removed by hand is made again) or checks out in
 * place. A directory that can't be used, a folder that is no worktree among them, is skipped and its lease dropped.
 * Undefined when none is free, or when `run` names no workflow.
 */
export function leaseStanding(options: {
  repo: string;
  run: RunRef;
  sha: string;
  env?: Env;
  now?: Date;
}): { path: string; raw: { dir: string; took?: StandingLease } } | undefined {
  const { repo, run, sha, env } = options;
  if (run.workflow === undefined) return undefined;
  const runsDir = runsDirOf(run);
  const holder = { runId: run.runId, runDir: resolve(run.runDir), pid: process.pid };
  for (let n = 0; n < (run.maxConcurrentRuns ?? 1); n++) {
    const dir = standingDir(runsDir, run.workflow, n);
    const path = join(dir, 'workspace');
    const taken = takeStanding(dir, holder, options.now);
    if (!taken.taken) continue;
    try {
      if (taken.took !== undefined) {
        const kept = keepHead(repo, taken.took, path, env);
        if (kept !== undefined && 'failed' in kept)
          throw new PortError('workspace', 'create', 'unavailable', kept.failed);
      }
      if (!existsSync(path)) {
        const added = gitSync(repo, [...NO_HOOKS, 'worktree', 'add', '--force', '--detach', path, sha], env);
        if (added.code !== 0) throw new PortError('workspace', 'create', 'unavailable', added.stderr);
      } else if (isWorktree(path, env)) {
        checkOutInPlace(path, sha, env);
      } else {
        throw new PortError('workspace', 'create', 'unavailable', `${path} is no git worktree`);
      }
    } catch {
      dropStanding(dir, run.runId);
      continue;
    }
    return { path, raw: taken.took === undefined ? { dir } : { dir, took: taken.took } };
  }
  return undefined;
}

/**
 * Frees the standing workspace at `path` for `run`: keeps its head at the run ref, as a release does, and drops the
 * lease, only while the run holds it. A run that no longer holds it has no head there that is its own, so nothing is
 * written and the lease is left. A ref that can't be written still drops the lease, and is `unavailable`.
 */
export function releaseStanding(
  repo: string,
  run: RunRef,
  path: string,
  env?: Env,
): { raw: GitResult | null; ref?: string; head?: string } {
  const dir = standingOf(runsDirOf(run), path);
  if (dir === undefined || !heldByRun(dir, run.runId)) return { raw: null };
  const kept = keepHead(repo, run, path, env);
  dropStanding(dir, run.runId);
  if (kept !== undefined && 'failed' in kept) throw new PortError('workspace', 'release', 'unavailable', kept.failed);
  return { raw: null, ...(kept ?? {}) };
}

/**
 * The standing workspace at `path` for a run that resumes: its own lease renewed with this process, then the worktree
 * checked as `reopenWorktree()` checks one. A workspace another run holds is `invalid`, naming that run.
 */
export function reopenStanding(
  run: RunRef,
  path: string,
  from: { branch: string; baseSha: string },
  env?: Env,
  now?: Date,
): Workspace {
  const dir = standingOf(runsDirOf(run), path);
  const invalid = (why: string) => new PortError('workspace', 'reopen', 'invalid', `${path}: ${why}`);
  if (dir === undefined) throw invalid('it is no standing workspace');
  const held = readStanding(dir);
  if (held !== undefined && held.runId !== run.runId) throw invalid(`standing workspace held by run ${held.runId}`);
  const taken = takeStanding(dir, { runId: run.runId, runDir: resolve(run.runDir), pid: process.pid }, now);
  if (!taken.taken) throw invalid(`standing workspace held by run ${taken.holder.runId}`);
  return reopenWorktree(path, from.branch, from.baseSha, env);
}

/** What `startWorkspace()` made: where the run works, how it got there, and the event's `standing` field. */
export interface Started {
  readonly path: string;
  readonly raw: NonNullable<unknown> | null;
  readonly standing?: 'leased' | 'none_free';
}

/**
 * The workspace of `run`'s start at `sha`: with `standing` on and `run.workflow` named, a standing workspace of its
 * workflow, else, when none is free, a detached worktree at `<runDir>/workspace`. With `standing` off, the latter alone,
 * and no `standing` field.
 */
export function startWorkspace(options: {
  repo: string;
  run: RunRef;
  sha: string;
  standing: boolean;
  env?: Env;
  now?: Date;
}): Started {
  const { repo, run, sha, env } = options;
  if (options.standing && run.workflow !== undefined) {
    const leased = leaseStanding({
      repo,
      run,
      sha,
      ...(env === undefined ? {} : { env }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (leased !== undefined) return { path: leased.path, raw: leased.raw, standing: 'leased' };
    const path = join(run.runDir, 'workspace');
    return { path, raw: addDetached(repo, path, sha, env), standing: 'none_free' };
  }
  const path = join(run.runDir, 'workspace');
  return { path, raw: addDetached(repo, path, sha, env) };
}

/** Gives up the standing workspace at `path` that `run` took, leaving the worktree: for a start that failed after it. */
export function abandonStanding(run: RunRef, path: string): void {
  const dir = standingOf(runsDirOf(run), path);
  if (dir !== undefined) dropStanding(dir, run.runId);
}

/** Whether `path` is a standing workspace of the runs directory `run` sits in. */
export const isStandingPath = (run: RunRef, path: string): boolean => standingOf(runsDirOf(run), path) !== undefined;
