// What one dispatched item's run needs from its watcher (DECISIONS D4-D6), asked on every tick by `dispatch.ts`. It
// reads the run's directory, its dispatch log and its lease, and answers by this table:
//
// | The item's run | The answer |
// |---|---|
// | its pid alive | in flight, counting against the cap; adopted on the dispatcher's first settle |
// | no `run.json`, the start's last line saying the definitions need a newer sail | outdated: the item is deferred and the dispatch held until the running sail changes, no attempt counted |
// | no `run.json` otherwise | a start that was refused, failed with the last line the start logged, or its exit code |
// | `completed` | done |
// | `failed stopped` | parked at once: a person stopped it, and a stopped run is never retried |
// | `failed` otherwise | a failed attempt, retried later or parked |
// | `running` with its pid dead, `suspended interrupted`, `suspended unwatched`, `suspended crashed` | adopted under its lease's pid when a live process holds its lease, else resumed, once; a resume of a crashed run that crashed again is parked with the `error:crash` message it left, and with why when it left none |
// | `suspended usage_limit` | adopted when a live process holds its lease; else held, and with it the whole dispatch, while now is before its reset time (or the back-off after it hit the limit), then resumed, even when this dispatcher resumed it before, unless its resume hit no limit since: then parked with why |
// | `suspended port_unavailable` | adopted when a live process holds its lease; else held, as its item alone, for the back-off its suspension's place in the run of them calls for (1, 2, 5, 10 then 30 minutes), then resumed; parked with why when its resume was not suspended again, and parked with the call, the count and the last port error once it has been suspended past the schedule |
// | anything else, such as `suspended until` or `budget_exceeded` | left: a person resumes or stops it |
//
// A limit with no event to date it by is dated by when the dispatcher first saw it (`limitedAt`). The suspensions of
// an unavailable port are counted from the run's events: those since its last `journal:append`, so a resume that got
// past the call that failed starts the schedule again.
//
// The lease comes before a resume because the item's pid is the process the watcher started last: a resume another
// process started, or one a watcher spawned and died before recording, holds the run's lease with a live pid. Adopting
// it then, rather than resuming the run a second time, keeps two processes off one workspace. A run this dispatcher has
// already resumed, found unended with its resume's process gone, and not on a usage limit or an unavailable port hit
// since, is parked with why: its resume failed, by the last
// line the resume itself logged (the log after the offset the spawn reported) or, with none, by its exit. A new
// dispatcher, a restart or the workflow watched again, starts with none resumed, so it gets one more chance.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RunStatus, readStatus } from '../engine/run-dir';
import { RUN_HEADER_FILE } from '../engine/run-header';
import { parseNewerSail } from '../engine/sdk-version';
import { readEvents } from '../events/consumers/ndjson';
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
  /** The time a usage limit's hold is measured against. */
  now: Date;
  /** How long a usage limit holds the dispatch when the run names no reset time. */
  backoffMs: number;
  /** How long a run suspended on an unavailable port holds the dispatch, by consecutive suspension; one past the end parks. */
  portBackoffMs: readonly number[];
  /** When this dispatcher first saw the run held, on its usage limit or an unavailable port: dates a hold whose run left no event for it. */
  limitedAt?: Date;
  /** The dispatcher's first settle: a live run is adopted. */
  first: boolean;
  /** Whether this dispatcher has already resumed the item's run. */
  resumed: boolean;
  /** When this dispatcher last resumed the item's run from a hold: no limit hit nor suspension on an unavailable port since means it failed. */
  resumedAt?: Date;
  /** When this dispatcher last resumed the item's run, whatever from: an `error:crash` before it is not this resume's. */
  resumeStartedAt?: Date;
  /** How the process this dispatcher last started for the item exited, once it has. */
  exited?: number | null;
  /** Where the output of the process this dispatcher last started for the item begins in its dispatch log. */
  logFrom?: number;
}

/** What to do with one dispatched item. */
export type Reconciled =
  | { kind: 'in-flight'; adopt: boolean }
  | { kind: 'done' }
  | { kind: 'failed'; reason: string }
  | { kind: 'park'; reason: string }
  | { kind: 'outdated'; reason: string }
  | { kind: 'wait' }
  | { kind: 'adopt'; pid: number }
  | { kind: 'resume'; from: ResumedFrom }
  | { kind: 'held'; stopReason: 'usage_limit' | 'port_unavailable'; until: string; reason: string };

function statusOf(runDir: string): RunStatus | undefined {
  try {
    return readStatus(runDir);
  } catch {
    return undefined;
  }
}

/**
 * When the usage limit the run suspended on lets it go on, and why it waits: the reset time its last `run:suspended`
 * names when that is after the event, else that event's time plus the back-off, else now plus the back-off.
 */
function usageLimitOf(
  runDir: string,
  context: Pick<ReconcileContext, 'now' | 'backoffMs' | 'limitedAt'>,
): { until: string; reason: string; at?: number } {
  const last = readEvents(runDir)
    .filter((event) => event.type === 'run:suspended' && event.stopReason === 'usage_limit')
    .at(-1);
  const key = last?.type === 'run:suspended' && last.stopReason === 'usage_limit' ? last.key : undefined;
  const resetsAt = last?.type === 'run:suspended' && last.stopReason === 'usage_limit' ? last.resetsAt : undefined;
  const base = last === undefined ? (context.limitedAt ?? context.now).getTime() : Date.parse(last.ts);
  // A reset time not after the limit was hit, as from a skewed clock, would resume the run into the limit again at once.
  const until =
    resetsAt !== undefined && Date.parse(resetsAt) > base ? resetsAt : new Date(base + context.backoffMs).toISOString();
  const call = key === undefined ? 'a run' : key;
  return { until, reason: `${call} hit the usage limit`, ...(last === undefined ? {} : { at: Date.parse(last.ts) }) };
}

/**
 * When a run suspended on an unavailable port may be resumed, and why it waits. The suspensions counted are those
 * since the run's last `journal:append`; the back-off is the schedule's entry for that count, after the last
 * suspension's time. `error` names the last unavailable port call the suspended call recorded.
 */
function portUnavailableOf(
  runDir: string,
  context: Pick<ReconcileContext, 'now' | 'portBackoffMs' | 'limitedAt'>,
): { count: number; key?: string; until: string; at?: number; error?: string } {
  const events = readEvents(runDir);
  const since = events.map((event) => event.type).lastIndexOf('journal:append');
  const suspensions = events
    .slice(since + 1)
    .filter((event) => event.type === 'run:suspended' && event.stopReason === 'port_unavailable');
  const last = suspensions.at(-1);
  const key = last?.type === 'run:suspended' && last.stopReason === 'port_unavailable' ? last.key : undefined;
  // Another call's error, as one that returned its errors or another member of a group took, is not this one's cause.
  const failed = events
    .filter(
      (event) =>
        event.type === 'error:port' &&
        event.code === 'unavailable' &&
        (key === undefined || callKeyOf(event.key ?? '') === key),
    )
    .at(-1);
  const count = Math.max(suspensions.length, 1);
  const base = last === undefined ? (context.limitedAt ?? context.now).getTime() : Date.parse(last.ts);
  const wait = context.portBackoffMs[Math.min(count, context.portBackoffMs.length) - 1] ?? 0;
  return {
    count,
    ...(key === undefined ? {} : { key }),
    until: new Date(base + wait).toISOString(),
    ...(last === undefined ? {} : { at: Date.parse(last.ts) }),
    ...(failed?.type === 'error:port' ? { error: `${failed.port}.${failed.op}: ${failed.message}` } : {}),
  };
}

/** The call a step's key belongs to: `stage#call` of `stage#call/step`. */
const callKeyOf = (key: string): string => key.split('/')[0] ?? key;

/** Where a run stands that a resume takes on, or undefined for any other. */
function resumable(status: RunStatus): ResumedFrom | undefined {
  if (status.status === 'running') return { status: 'running' };
  const { stopReason } = status;
  if (
    status.status === 'suspended' &&
    (stopReason === 'interrupted' || stopReason === 'unwatched' || stopReason === 'crashed')
  ) {
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
 * or undefined when none does. A marked lease has no live holder, whatever its pid.
 */
export async function liveHolder(
  runDir: string,
  runId: string,
  context: Pick<ReconcileContext, 'isAlive' | 'workspace'>,
): Promise<number | undefined> {
  const lease = leaseOf(runDir);
  if (lease === undefined) return undefined;
  const holder = await context.workspace.holder(lease.remote, lease.branch);
  return holder?.runId === runId && !holder.suspended && context.isAlive(holder.pid) ? holder.pid : undefined;
}

/** The message of the run's last `error:crash` after `since`, or undefined when it has none: an older crash is not this resume's. */
function crashedSince(runDir: string, since: Date | undefined): string | undefined {
  if (since === undefined) return undefined;
  const crash = readEvents(runDir).findLast((event) => event.type === 'error:crash');
  return crash?.type === 'error:crash' && Date.parse(crash.ts) > since.getTime() ? crash.message : undefined;
}

/**
 * Why the process the dispatcher started for the item ended without its work: the last line it logged, or its exit.
 * Only what the log gained from `logFrom` on is the process's, so a resume never quotes the run it resumed.
 */
function why(context: ReconcileContext, runId: string, what: string): string | undefined {
  const line = lastLine(dispatchLog(context.runsDir, context.workflow, runId), context.logFrom);
  if (line !== undefined) return `${what}: ${line}`;
  if (context.exited === undefined) return undefined;
  return context.exited === null ? `${what}: it was ended by a signal` : `${what}: it exited ${context.exited}`;
}

export async function reconcileItem(item: QueueItem, context: ReconcileContext): Promise<Reconciled> {
  if (item.pid !== undefined && context.isAlive(item.pid)) return { kind: 'in-flight', adopt: context.first };
  const runId = item.runId ?? '';
  const runDir = join(context.runsDir, runId);
  if (!existsSync(join(runDir, RUN_HEADER_FILE))) {
    const line = lastLine(dispatchLog(context.runsDir, context.workflow, runId), context.logFrom);
    // The start prints `sail <ref>: <message>`; the message is what `newerSailRefusal()` made.
    const message = line?.replace(/^sail \S+: /, '');
    if (message !== undefined && parseNewerSail(message) !== undefined) return { kind: 'outdated', reason: message };
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
  if (status.status === 'suspended' && status.stopReason === 'usage_limit') {
    const holder = await liveHolder(runDir, runId, context);
    if (holder !== undefined) return { kind: 'adopt', pid: holder };
    const { until, reason, at } = usageLimitOf(runDir, context);
    if (context.resumedAt !== undefined && (at === undefined || at <= context.resumedAt.getTime())) {
      return { kind: 'park', reason: why(context, runId, 'its resume failed') ?? 'its resume failed' };
    }
    if (context.now.getTime() < Date.parse(until)) return { kind: 'held', stopReason: 'usage_limit', until, reason };
    return { kind: 'resume', from: { status: 'suspended', stopReason: 'usage_limit' } };
  }
  if (status.status === 'suspended' && status.stopReason === 'port_unavailable') {
    const holder = await liveHolder(runDir, runId, context);
    if (holder !== undefined) return { kind: 'adopt', pid: holder };
    const { count, key, until, at, error } = portUnavailableOf(runDir, context);
    if (context.resumedAt !== undefined && (at === undefined || at <= context.resumedAt.getTime())) {
      return { kind: 'park', reason: why(context, runId, 'its resume failed') ?? 'its resume failed' };
    }
    const call = `${key ?? 'a run'} could not reach a provider`;
    if (count > context.portBackoffMs.length) {
      const last = error === undefined ? '' : `: ${error}`;
      return { kind: 'park', reason: `${call} on ${count} suspensions in a row${last}` };
    }
    if (context.now.getTime() < Date.parse(until)) {
      return {
        kind: 'held',
        stopReason: 'port_unavailable',
        until,
        reason: error === undefined ? call : `${call}: ${error}`,
      };
    }
    return { kind: 'resume', from: { status: 'suspended', stopReason: 'port_unavailable' } };
  }
  const from = resumable(status);
  if (from === undefined) return { kind: 'wait' };
  const holder = await liveHolder(runDir, runId, context);
  if (holder !== undefined) return { kind: 'adopt', pid: holder };
  if (context.resumed) {
    const crash = status.stopReason === 'crashed' ? crashedSince(runDir, context.resumeStartedAt) : undefined;
    const reason =
      crash === undefined
        ? (why(context, runId, 'its resume failed') ?? 'its resume failed')
        : `its resume failed: ${crash}`;
    return { kind: 'park', reason };
  }
  return { kind: 'resume', from };
}
