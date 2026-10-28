// Machine-wide branch leases (ADR-0018, D9): one file per remote and branch in `~/.sail/leases/`, so manual and watched
// runs never hold the same branch. Every built-in Workspace adapter takes its leases here.
//
// A lease is taken before its run directory exists, since a leased branch is a refusal, and a refusal leaves no run
// directory. So a lease is stale once its run has ended, or once its pid is dead while the run is running or has no
// STATUS yet. A suspended run holds its lease whatever its pid. Two accepted risks: a reused pid makes a dead run read as
// alive, and three processes interleaving on one stale lease within microseconds could drop the lease just taken.
//
// A renewal is the same run taking its lease again: a resume, with its own pid. It is refused while the pid on the lease
// is alive and isn't the renewing one, whatever STATUS says: a run's STATUS reads `suspended` both while another
// resume is starting it and while its own process is suspending it. So a resume can't run a run that is still running,
// and two resumes of one run can't both go ahead. A reused pid refuses a resume until that process ends: the same
// accepted risk.
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAlive } from '../engine/process';
import { readStatus } from '../engine/run-dir';
import { PortError } from '../ports/errors';
import { Lease, LeaseHolder, type LeaseResult, type Released } from '../ports/types';

export { isAlive };

/** Where leases live unless a caller names a directory. Computed per call, so importing this reads nothing. */
export function defaultLeasesDir(): string {
  return join(homedir(), '.sail', 'leases');
}

/** The lease file for `remote` and `branch`: the first 16 hex of sha256(`<remote>\n<branch>`), plus `.json`. */
export function leaseFile(dir: string, remote: string, branch: string): string {
  const hex = new Bun.CryptoHasher('sha256').update(`${remote}\n${branch}`).digest('hex');
  return join(dir, `${hex.slice(0, 16)}.json`);
}

/** The filesystem refused `path`: `unavailable`, naming it and the errno. */
const unavailable = (path: string, error: unknown): PortError =>
  new PortError('workspace', 'lease', 'unavailable', `${path}: ${(error as Error).message}`);

/**
 * The lease in `file`, or undefined when there is no file. A file that isn't a lease is `invalid`, and a filesystem
 * failure is `unavailable`.
 */
function readFile(file: string): Lease | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw unavailable(file, error);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new PortError('workspace', 'lease', 'invalid', `${file}: ${(error as Error).message}`);
  }
  const result = Lease.safeParse(data);
  if (!result.success) {
    const [issue] = result.error.issues;
    throw new PortError('workspace', 'lease', 'invalid', `${file}: ${issue?.path.join('.')} ${issue?.message}`);
  }
  return result.data;
}

/** The lease on `remote` and `branch`, or undefined when there is none. A file that isn't a lease, or one that can't be read, throws. */
export function readLease(dir: string, remote: string, branch: string): Lease | undefined {
  return readFile(leaseFile(dir, remote, branch));
}

/** Whether `lease`'s run no longer holds it: its run has ended, or it isn't suspended and its pid is dead. */
export function isStale(lease: Lease): boolean {
  let status: string | undefined;
  try {
    status = readStatus(lease.runDir).status;
  } catch {
    // No STATUS yet: the lease was taken before its run directory was made, or the run never got that far.
    status = undefined;
  }
  if (status === 'completed' || status === 'failed') return true;
  if (status === 'suspended') return false;
  return !isAlive(lease.pid);
}

/**
 * The lease that holds `branch` of `remote` now, or undefined when there is none or it is stale. It only reads: a stale
 * lease is left for the next taker. A file that isn't a lease is `invalid`, a filesystem failure `unavailable`.
 */
export function heldLease(dir: string, remote: string, branch: string): Lease | undefined {
  const lease = readLease(dir, remote, branch);
  return lease === undefined || isStale(lease) ? undefined : lease;
}

/** Whether `lease`'s run is alive in a process other than `pid`: its pid is alive and isn't `pid`. */
function stillRunning(lease: Lease, pid: number): boolean {
  return lease.pid !== pid && isAlive(lease.pid);
}

const text = (lease: Lease): string => `${JSON.stringify(lease)}\n`;

/**
 * Creates `file` holding `lease` all at once, by linking a written temp file to it. False when `file` exists. The temp
 * file is removed whatever happens, a write that failed part way included.
 */
function create(file: string, lease: Lease): boolean {
  const tmp = `${file}.${lease.runId}.${process.pid}.tmp`;
  try {
    try {
      writeFileSync(tmp, text(lease));
    } catch (error) {
      throw unavailable(tmp, error);
    }
    try {
      linkSync(tmp, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw unavailable(file, error);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Drops the lease in `file` when it is still `read`: moves it aside under a name only `runId` in this process uses,
 * then checks that what moved is that lease, and not one another taker has just written in its place. False when the
 * file held another lease, which is put back unless a third taker has created the file meanwhile, or when there was no
 * file.
 */
function dropIfStill(file: string, read: Lease, runId: string): boolean {
  const aside = `${file}.${runId}.${process.pid}.aside`;
  try {
    renameSync(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw unavailable(file, error);
  }
  const moved = readFile(aside);
  const same = moved !== undefined && JSON.stringify(moved) === JSON.stringify(read);
  if (!same) {
    try {
      linkSync(aside, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable(file, error);
    }
  }
  rmSync(aside, { force: true });
  return same;
}

/**
 * Leases `branch` of `remote` to `holder`: a new lease, a renewal by the same run (a resume), or a stale lease taken
 * over, with `took` naming the run it replaced. A lease a live run holds is refused, naming it, and so is a renewal
 * while the lease's pid is alive in another process. A renewal or a takeover
 * replaces only the lease it read, so one landing in between is never overwritten.
 */
export function takeLease(
  dir: string,
  remote: string,
  branch: string,
  holder: LeaseHolder,
  now = new Date(),
): LeaseResult {
  // A holder that isn't one would write a file every later taker reads as invalid, blocking the branch.
  const checked = LeaseHolder.safeParse(holder);
  if (!checked.success) {
    const [issue] = checked.error.issues;
    throw new PortError('workspace', 'lease', 'invalid', `holder: ${issue?.path.join('.')} ${issue?.message}`);
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw unavailable(dir, error);
  }
  const file = leaseFile(dir, remote, branch);
  const { runId, runDir, pid } = checked.data;
  const lease: Lease = { remote, branch, runId, runDir, pid, takenAt: now.toISOString() };
  // A second round only follows another taker winning a step of the first.
  for (let round = 0; round < 2; round++) {
    const held = readFile(file);
    if (held === undefined) {
      if (create(file, lease)) return { leased: true, lease, raw: lease };
      continue;
    }
    const renewal = held.runId === runId;
    if (renewal ? stillRunning(held, pid) : !isStale(held)) return { leased: false, holder: held, raw: held };
    if (dropIfStill(file, held, runId) && create(file, lease)) {
      return renewal ? { leased: true, lease, raw: lease } : { leased: true, lease, took: held.runId, raw: lease };
    }
  }
  const current = readFile(file);
  if (current !== undefined) return { leased: false, holder: current, raw: current };
  throw new PortError('workspace', 'lease', 'conflict', `${remote} ${branch}: the lease kept changing hands`);
}

/** Removes the lease, only when `runId` holds it: a lease taken over since it was read is left to its new holder. */
export function releaseLease(dir: string, remote: string, branch: string, runId: string): Released {
  const file = leaseFile(dir, remote, branch);
  const held = readFile(file);
  if (held === undefined || held.runId !== runId) return { released: false, raw: held ?? null };
  if (dropIfStill(file, held, runId)) return { released: true, raw: held };
  return { released: false, raw: readFile(file) ?? null };
}
