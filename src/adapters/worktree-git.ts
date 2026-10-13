// The git plumbing the fake and the git-worktree workspaces share, so the two cannot drift apart: a run's diff against
// its base, the worktree removal with its fallbacks, and whether a run has ended (ADR-0018, D6, D8).
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { readStatus } from '../engine/run-dir';
import { PortError } from '../ports/errors';
import type { Diff } from '../ports/types';

export interface GitResult {
  readonly code: number;
  /** As git wrote it: a patch's trailing newline and whitespace are part of it. */
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `git <args>` in `cwd`, whatever the adapter's environment for it is. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;

/** A workspace's path relative to the clone, as events carry it (D7). */
export function clonePath(clone: string, path: string): string {
  return relative(resolve(clone), resolve(path));
}

/** Whether the run in `runDir` has ended, so its workspace can go. A run with no STATUS hasn't. */
export function endedRun(runDir: string): boolean {
  try {
    const { status } = readStatus(runDir);
    return status === 'completed' || status === 'failed';
  } catch {
    return false;
  }
}

/**
 * The working tree at `path` against `from`, as a patch that applies to `from`. It diffs against the merge-base of `from`
 * and HEAD, which is what `from...HEAD` means (D6). New files that aren't ignored are included, ignored ones not.
 */
export async function diffFrom(git: GitRunner, path: string, from: string): Promise<Diff> {
  const resolved = await git(path, ['rev-parse', '--verify', '--quiet', `${from}^{commit}`]);
  if (resolved.code !== 0) {
    throw new PortError('workspace', 'diff', 'invalid', `${path}: ${from} names no commit ${resolved.stderr}`);
  }
  const shared = await git(path, ['merge-base', resolved.stdout.trim(), 'HEAD']);
  if (shared.code !== 0) {
    throw new PortError(
      'workspace',
      'diff',
      'invalid',
      `${path}: ${from} shares no history with HEAD ${shared.stderr}`,
    );
  }
  const tracked = await git(path, ['diff', '--binary', shared.stdout.trim(), '--']);
  if (tracked.code !== 0) throw new PortError('workspace', 'diff', 'unavailable', `${path}: ${tracked.stderr}`);
  // A file the run created is part of the working tree too. Each new file that isn't ignored is diffed against
  // nothing, which leaves the index alone; `--no-index` exits 1 when the two differ, as a new file always does.
  const listed = await git(path, ['ls-files', '--others', '--exclude-standard', '-z']);
  const created: GitResult[] = [];
  for (const file of listed.stdout.split('\0')) {
    if (file !== '') created.push(await git(path, ['diff', '--no-index', '--binary', '--', '/dev/null', file]));
  }
  const failed = created.find((result) => result.code !== 1);
  if (listed.code !== 0 || failed !== undefined) {
    throw new PortError('workspace', 'diff', 'unavailable', `${path}: ${(failed ?? listed).stderr}`);
  }
  return { patch: tracked.stdout + created.map((result) => result.stdout).join(''), raw: { tracked, created } };
}

/** Whether `path` is a symbolic link, so that git or `rm` would act on what it points to. A missing path is not one. */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether `baseSha` is an ancestor of the HEAD of the worktree at `path`, so a resumed run is still on its base. */
export async function basedOn(git: GitRunner, path: string, baseSha: string): Promise<boolean> {
  return (await git(path, ['merge-base', '--is-ancestor', baseSha, 'HEAD'])).code === 0;
}

/**
 * Removes the worktree at `path` from the repository, and fails only when it is still there. A path reached through a
 * symbolic link, at the workspace or at its run directory, is refused before git or `rm` can follow it.
 */
export async function removeWorktree(git: GitRunner, repo: string, op: string, path: string): Promise<GitResult> {
  if (isLink(path) || isLink(dirname(path))) {
    throw new PortError('workspace', op, 'invalid', `${path} is reached through a symbolic link: it is not removed`);
  }
  const removed = await git(repo, ['worktree', 'remove', '--force', resolve(path)]);
  await git(repo, ['worktree', 'prune']);
  if (removed.code === 0 || !existsSync(path)) return removed;
  // A run copied from another clone keeps a worktree this repository has no record of: the directory is still the run's.
  if (!removed.stderr.includes('is not a working tree')) {
    throw new PortError('workspace', op, 'unavailable', removed.stderr);
  }
  rmSync(path, { recursive: true, force: true });
  return removed;
}

/** Removes the workspaces of the ended runs under `runsDir`, and gives their paths, sorted. */
export async function sweepRuns(git: GitRunner, repo: string, runsDir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of existsSync(runsDir) ? readdirSync(runsDir) : []) {
    const runDir = join(runsDir, entry);
    const path = join(runDir, 'workspace');
    // A link where a run directory or its workspace should be is not the run's: it is skipped, not followed.
    if (isLink(runDir) || isLink(path) || !existsSync(path) || !endedRun(runDir)) continue;
    await removeWorktree(git, repo, 'sweep', path);
    paths.push(path);
  }
  return paths.sort();
}
