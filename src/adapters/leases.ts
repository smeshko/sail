// Machine-wide branch leases (ADR-0018, D9): one file per remote and branch in `~/.sail/leases/`, so manual and watched
// runs never hold the same branch. Every built-in Workspace adapter takes its leases here.
// STUB (TASK-007): nothing is leased, read or released yet.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Lease, LeaseHolder, LeaseResult, Released } from '../ports/types';

/** Where leases live unless a caller names a directory. Computed per call, so importing this reads nothing. */
export function defaultLeasesDir(): string {
  return join(homedir(), '.sail');
}

/** The lease on `remote` and `branch`, or undefined when there is none. A file that isn't a lease throws. */
export function readLease(_dir: string, _remote: string, _branch: string): Lease | undefined {
  return undefined;
}

/**
 * Leases `branch` of `remote` to `holder`: a new lease, a renewal by the same run, or a stale lease taken over. A lease
 * a live run holds is refused, naming it.
 */
export function takeLease(
  _dir: string,
  remote: string,
  branch: string,
  holder: LeaseHolder,
  now = new Date(),
): LeaseResult {
  return { leased: false, holder: { remote, branch, ...holder, takenAt: now.toISOString() }, raw: null };
}

/** Removes the lease, only when `runId` holds it. */
export function releaseLease(_dir: string, _remote: string, _branch: string, _runId: string): Released {
  return { released: false, raw: null };
}
