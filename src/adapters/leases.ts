// Branch leases (ADR-0018, D9): one pid-held file per remote and branch in the selected machine directory's `leases/`
// (`$SAIL_HOME/leases/`, or `~/.sail/leases/`), so manual and watched runs sharing that directory never hold the same branch.
// Keys ignore scheme, user and port, and normalise host and path case, `.git` and trailing slashes.
// Different machine directories have independent leases. The shared primitive serialises removals under drop tokens.
// Every built-in Workspace adapter takes its leases here. A run resumed under another `SAIL_HOME` finds no lease
// of its own there.
//
// A lease is taken before its run directory exists, since a leased branch is a refusal, and a refusal leaves no run
// directory. So a lease is stale once its run has ended, or once its pid is dead while the run is running or has no
// STATUS yet. A suspended run holds its lease whatever its pid. Accepted risk: a reused pid reads as alive.
//
// A renewal is the same run taking its lease again: a resume, with its own pid. It is refused while the pid on the lease
// is alive and isn't the renewing one, whatever STATUS says: a run's STATUS reads `suspended` both while another
// resume is starting it and while its own process is suspending it. So a resume can't run a run that is still running,
// and two resumes of one run can't both go ahead. A reused pid refuses a resume until that process ends: the same
// accepted risk.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { machineDir } from '../engine/machine-dir';
import { dropRecord, type PidFileKind, readRecord, takeRecord } from '../engine/pid-file';
import { isAlive } from '../engine/process';
import { readStatus } from '../engine/run-dir';
import { PortError } from '../ports/errors';
import { Lease, LeaseHolder, type LeaseResult, type Released } from '../ports/types';

export { isAlive };

const leaseKind: PidFileKind<Lease> = {
  schema: Lease,
  error: (kind, message) => new PortError('workspace', 'lease', kind, message),
  tag: (lease) => lease.runId,
};

/** Where leases live unless a caller names a directory. Computed per call, so importing this reads nothing. */
export function defaultLeasesDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(machineDir(env), 'leases');
}

/**
 * A remote's host/path key: `git@github.com:o/r.git`, `ssh://github.com:2222/O/R/` and
 * `https://user:token@GitHub.com/o/r.git/` all name `github.com/o/r`. Hostless remotes pass through.
 */
export function leaseKey(remote: string): string {
  const url = /^[^/]+:\/\/([^/]*)(\/.*)?$/.exec(remote);
  let host: string;
  let path: string;
  if (url) {
    const authority = (url[1] ?? '').split('@').at(-1) ?? '';
    host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : (authority.split(':')[0] ?? '');
    path = url[2] ?? '';
  } else {
    if (remote.includes('://')) return remote;
    const scp = /^([^/:]+):(.*)$/.exec(remote);
    if (!scp) return remote;
    host = (scp[1] ?? '').split('@').at(-1) ?? '';
    path = scp[2] ?? '';
  }
  if (!host) return remote;
  path = path
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return `${host.toLowerCase()}/${path}`;
}

/** The lease file: first 16 hex of sha256(`<leaseKey(remote)>\n<branch>`), plus `.json`. */
export function leaseFile(dir: string, remote: string, branch: string): string {
  const hex = new Bun.CryptoHasher('sha256').update(`${leaseKey(remote)}\n${branch}`).digest('hex');
  return join(dir, `${hex.slice(0, 16)}.json`);
}

// Bridge for one release (ADW-175): drop with the next release.
function legacyLeaseFile(dir: string, remote: string, branch: string): string | undefined {
  const hex = new Bun.CryptoHasher('sha256').update(`${remote}\n${branch}`).digest('hex');
  const file = join(dir, `${hex.slice(0, 16)}.json`);
  return file === leaseFile(dir, remote, branch) ? undefined : file;
}

/** The lease on `remote` and `branch`, or undefined when there is none. Invalid or unreadable files throw. */
export function readLease(dir: string, remote: string, branch: string): Lease | undefined {
  const lease = readRecord(leaseFile(dir, remote, branch), leaseKind);
  if (lease) return lease;
  const legacy = legacyLeaseFile(dir, remote, branch);
  return legacy === undefined ? undefined : readRecord(legacy, leaseKind);
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

/** The live lease, or undefined when free or stale. A stale lease is left for the next taker. */
export function heldLease(dir: string, remote: string, branch: string): Lease | undefined {
  const lease = readLease(dir, remote, branch);
  return lease === undefined || isStale(lease) ? undefined : lease;
}

/** Whether `lease`'s run is alive in a process other than `pid`: its pid is alive and isn't `pid`. */
function stillRunning(lease: Lease, pid: number): boolean {
  return lease.pid !== pid && isAlive(lease.pid);
}

/**
 * Leases `branch` of `remote` to `holder`: a new lease, a renewal by the same run (a resume), or a stale lease taken
 * over, with `took` naming the run it replaced. A lease a live run holds is refused, naming it, and so is a renewal
 * while the lease's pid is alive in another process. A renewal or takeover replaces only the lease it read.
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
    throw new PortError('workspace', 'lease', 'unavailable', `${dir}: ${(error as Error).message}`);
  }
  const file = leaseFile(dir, remote, branch);
  const { runId, runDir, pid } = checked.data;
  const lease: Lease = { remote, branch, runId, runDir, pid, takenAt: now.toISOString() };
  const blocks = (held: Lease) => (held.runId === runId ? stillRunning(held, pid) : !isStale(held));
  const legacy = legacyLeaseFile(dir, remote, branch);
  const old = legacy === undefined ? undefined : readRecord(legacy, leaseKind);
  if (old && legacy) {
    if (blocks(old)) return { leased: false, holder: old, raw: old };
    if (!dropRecord(legacy, old, leaseKind) && readRecord(legacy, leaseKind) !== undefined) {
      throw new PortError('workspace', 'lease', 'conflict', `${remote} ${branch}: the lease kept changing hands`);
    }
  }
  const result = takeRecord(file, lease, leaseKind, blocks);
  if (result.taken) {
    const took = result.took ?? old;
    return took && took.runId !== runId
      ? { leased: true, lease, took: took.runId, raw: lease }
      : { leased: true, lease, raw: lease };
  }
  if ('holder' in result) return { leased: false, holder: result.holder, raw: result.holder };
  throw new PortError('workspace', 'lease', 'conflict', `${remote} ${branch}: the lease kept changing hands`);
}

/** Removes the lease, only when `runId` holds it: a lease taken over since it was read is left to its new holder. */
export function releaseLease(dir: string, remote: string, branch: string, runId: string): Released {
  const files = [leaseFile(dir, remote, branch), legacyLeaseFile(dir, remote, branch)];
  let released: Lease | undefined;
  let remaining: Lease | undefined;
  for (const file of files) {
    if (file === undefined) continue;
    const held = readRecord(file, leaseKind);
    if (held?.runId === runId) {
      if (dropRecord(file, held, leaseKind)) released = held;
      else remaining ??= readRecord(file, leaseKind);
    } else {
      remaining ??= held;
    }
  }
  return released ? { released: true, raw: released } : { released: false, raw: remaining ?? null };
}
