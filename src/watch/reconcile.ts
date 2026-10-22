// What one dispatched item's run needs from its watcher (DECISIONS D4-D6), asked on every tick by `dispatch.ts`. It
// reads the run's directory, its dispatch log and its lease, and answers by this table:
//
// | The item's run | The answer |
// |---|---|
// | its pid alive | in flight, counting against the cap; adopted on the dispatcher's first settle |
// | no `run.json` | a start that was refused, failed with its dispatch log's last line or its exit code |
// | `completed` | done |
// | `failed stopped` | parked at once: a person stopped it, and a stopped run is never retried |
// | `failed` otherwise | a failed attempt, retried later or parked |
// | `running` with its pid dead, `suspended interrupted`, `suspended unwatched` | adopted under its lease's pid when a live process holds its lease, else resumed, once |
// | anything else, such as `suspended until` or `budget_exceeded` | left: a person resumes or stops it |
//
// The lease comes before a resume because the item's pid is the process the watcher started last: a resume another
// process started, or one a watcher spawned and died before recording, holds the run's lease with a live pid. Adopting
// it then, rather than resuming the run a second time, keeps two processes off one workspace. A run this dispatcher has
// already resumed, found unended with its resume's process gone, is parked with why: its resume failed. A new
// dispatcher, a restart or the workflow watched again, starts with none resumed, so it gets one more chance.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RunStatus, readStatus } from '../engine/run-dir';
import { RUN_HEADER_FILE } from '../engine/run-header';
import type { ResumedFrom } from '../events/types';
import type { WorkspacePort } from '../ports/workspace';
import type { QueueItem } from './queue-store';
import { dispatchLog, lastLine } from './spawn';

export interface ReconcileContext {
  runsDir: string;
  workflow: string;
  isAlive: (pid: number) => boolean;
  /** Where the run's lease is read, before a resume. */
  workspace: Pick<WorkspacePort, 'holder'>;
  /** The dispatcher's first settle: a live run is adopted. */
  first: boolean;
  /** Whether this dispatcher has already resumed the item's run. */
  resumed: boolean;
  /** How the process this dispatcher last started for the item exited, once it has. */
  exited?: number | null;
}

/** What to do with one dispatched item. */
export type Reconciled =
  | { kind: 'in-flight'; adopt: boolean }
  | { kind: 'done' }
  | { kind: 'failed'; reason: string }
  | { kind: 'park'; reason: string }
  | { kind: 'wait' }
  | { kind: 'adopt'; pid: number }
  | { kind: 'resume'; from: ResumedFrom };

function statusOf(runDir: string): RunStatus | undefined {
  try {
    return readStatus(runDir);
  } catch {
    return undefined;
  }
}

/** Where a run stands that a resume takes on, or undefined for any other. */
function resumable(status: RunStatus): ResumedFrom | undefined {
  if (status.status === 'running') return { status: 'running' };
  const { stopReason } = status;
  if (status.status === 'suspended' && (stopReason === 'interrupted' || stopReason === 'unwatched')) {
    return { status: 'suspended', stopReason };
  }
  return undefined;
}

/** The remote and branch the run's lease is keyed by, from its `run.json`, or undefined when it names none. */
function leaseOf(runDir: string): { remote: string; branch: string } | undefined {
  try {
    const header = JSON.parse(readFileSync(join(runDir, RUN_HEADER_FILE), 'utf8'));
    const remote = header?.repository?.url;
    const branch = header?.branch;
    return typeof remote === 'string' && typeof branch === 'string' ? { remote, branch } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pid of a live process that holds run `runId`'s lease, as a resume started by hand or by an earlier watcher does,
 * or undefined when none does.
 */
export async function liveHolder(
  runDir: string,
  runId: string,
  context: Pick<ReconcileContext, 'isAlive' | 'workspace'>,
): Promise<number | undefined> {
  const lease = leaseOf(runDir);
  if (lease === undefined) return undefined;
  const holder = await context.workspace.holder(lease.remote, lease.branch);
  return holder?.runId === runId && context.isAlive(holder.pid) ? holder.pid : undefined;
}

/** Why the process the dispatcher started for the item ended without its work: its log's last line, or its exit. */
function why(context: ReconcileContext, runId: string, what: string): string | undefined {
  const line = lastLine(dispatchLog(context.runsDir, context.workflow, runId));
  if (line !== undefined) return `${what}: ${line}`;
  return context.exited === undefined ? undefined : `${what}: it exited ${context.exited}`;
}

export async function reconcileItem(item: QueueItem, context: ReconcileContext): Promise<Reconciled> {
  if (item.pid !== undefined && context.isAlive(item.pid)) return { kind: 'in-flight', adopt: context.first };
  const runId = item.runId ?? '';
  const runDir = join(context.runsDir, runId);
  if (!existsSync(join(runDir, RUN_HEADER_FILE))) {
    return {
      kind: 'failed',
      reason: why(context, runId, 'its start was refused') ?? 'its start left no run directory',
    };
  }
  const status = statusOf(runDir);
  if (status === undefined) return { kind: 'wait' };
  if (status.status === 'completed') return { kind: 'done' };
  if (status.status === 'failed') {
    if (status.stopReason === 'stopped') return { kind: 'park', reason: `run ${runId} was stopped` };
    return { kind: 'failed', reason: `run ${runId} failed (${status.stopReason})` };
  }
  const from = resumable(status);
  if (from === undefined) return { kind: 'wait' };
  const holder = await liveHolder(runDir, runId, context);
  if (holder !== undefined) return { kind: 'adopt', pid: holder };
  if (context.resumed) {
    const reason = why(context, runId, 'its resume failed') ?? 'its resume failed';
    return { kind: 'park', reason };
  }
  return { kind: 'resume', from };
}
