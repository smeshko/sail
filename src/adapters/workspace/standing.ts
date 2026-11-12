// Standing workspaces: a worktree the `git-worktree` adapter (and the fake) keeps at
// `<runsDir>/standing/<workflow>-<n>/workspace` between runs, so the build caches git ignores are still there for the
// next run of the workflow. One pid-held `LEASE` file beside the worktree says which run holds it.
//
// A standing lease is stricter than a branch lease. It is stale once its run has ended (`completed` or `failed`), or has
// no STATUS yet and a dead pid. A run that is `running` or `suspended` holds it whatever its pid: a crashed run the
// watcher resumes would otherwise lose its uncommitted work to another run's checkout.
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { dropRecord, type PidFileKind, readRecord, takeRecord } from '../../engine/pid-file';
import { isAlive } from '../../engine/process';
import { readStatus } from '../../engine/run-dir';
import { PortError } from '../../ports/errors';

/** The folder of `.sail-runs/` the standing workspaces live in. */
export const STANDING_DIR = 'standing';

/** The file beside a standing workspace that says who holds it. */
export const STANDING_LEASE_FILE = 'LEASE';

/** Who holds a standing workspace, and since when. */
export const StandingLease = z.object({
  runId: z.string().min(1),
  runDir: z.string().min(1),
  pid: z.number().int().positive(),
  takenAt: z.string(),
});
export type StandingLease = z.infer<typeof StandingLease>;

/** What a run that takes a standing workspace says about itself. */
export type StandingHolder = Pick<StandingLease, 'runId' | 'runDir' | 'pid'>;

const standingKind: PidFileKind<StandingLease> = {
  schema: StandingLease,
  error: (kind, message) => new PortError('workspace', 'lease', kind, message),
  tag: (lease) => lease.runId,
};

/** The directory of standing workspace `n` of `workflow`: its worktree and its lease are inside. */
export function standingDir(runsDir: string, workflow: string, n: number): string {
  return join(runsDir, STANDING_DIR, `${workflow}-${n}`);
}

/** The worktree of standing workspace `n` of `workflow`. */
export function standingPath(runsDir: string, workflow: string, n: number): string {
  return join(standingDir(runsDir, workflow, n), 'workspace');
}

/**
 * The standing directory `path` is the worktree of, when `path` is exactly `<runsDir>/standing/<one plain name>/workspace`,
 * else undefined.
 */
export function standingOf(runsDir: string, path: string): string | undefined {
  const target = resolve(path);
  if (basename(target) !== 'workspace') return undefined;
  const dir = dirname(target);
  const name = basename(dir);
  if (name === '' || name === '.' || name === '..') return undefined;
  return dirname(dir) === resolve(runsDir, STANDING_DIR) ? dir : undefined;
}

/** Whether `lease`'s run no longer holds the workspace: it has ended, or it has no STATUS and its pid is dead. */
export function standingStale(lease: StandingLease): boolean {
  let status: string | undefined;
  try {
    status = readStatus(lease.runDir).status;
  } catch {
    status = undefined;
  }
  if (status === 'completed' || status === 'failed') return true;
  if (status !== undefined) return false;
  return !isAlive(lease.pid);
}

const leaseFileOf = (dir: string): string => join(dir, STANDING_LEASE_FILE);

/** The lease on the standing directory `dir`, or undefined when there is none. */
export function readStanding(dir: string): StandingLease | undefined {
  return readRecord(leaseFileOf(dir), standingKind);
}

/**
 * Leases `dir` to `holder`: a free one, one the same run holds (a renewal), or a stale one taken over, `took` naming the
 * lease it replaced. One a live run holds is refused, naming it.
 */
export function takeStanding(
  dir: string,
  holder: StandingHolder,
  now: Date = new Date(),
): { taken: true; took?: StandingLease } | { taken: false; holder: StandingLease } {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new PortError('workspace', 'lease', 'unavailable', `${dir}: ${(error as Error).message}`);
  }
  const lease: StandingLease = {
    runId: holder.runId,
    runDir: holder.runDir,
    pid: holder.pid,
    takenAt: now.toISOString(),
  };
  const blocks = (held: StandingLease) => held.runId !== holder.runId && !standingStale(held);
  const result = takeRecord(leaseFileOf(dir), lease, standingKind, blocks);
  if (result.taken) {
    return result.took !== undefined && result.took.runId !== holder.runId
      ? { taken: true, took: result.took }
      : { taken: true };
  }
  if ('holder' in result) return { taken: false, holder: result.holder };
  throw new PortError('workspace', 'lease', 'conflict', `${dir}: the lease kept changing hands`);
}

/**
 * Puts `lease` back on `dir` in place of `runId`'s, only while `runId` holds it: for a takeover that could not keep the
 * stale holder's head, so the next start tries again. Answers whether it did.
 */
export function restoreStanding(dir: string, runId: string, lease: StandingLease): boolean {
  return takeRecord(leaseFileOf(dir), lease, standingKind, (held) => held.runId !== runId).taken;
}

/** Whether `runId` holds the lease on `dir`. */
export function heldByRun(dir: string, runId: string): boolean {
  return readStanding(dir)?.runId === runId;
}

/** Drops the lease on `dir`, only when `runId` holds it. Answers whether it did. */
export function dropStanding(dir: string, runId: string): boolean {
  const held = readStanding(dir);
  if (held === undefined || held.runId !== runId) return false;
  return dropRecord(leaseFileOf(dir), held, standingKind);
}
