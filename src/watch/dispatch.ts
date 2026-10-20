// One watched workflow's dispatch: each tick settles the items whose run has ended, then starts due items while the
// workflow is under its `maxConcurrentRuns`.
//
// - **In flight** is an item `dispatched` whose pid is alive. Only those count against the cap. One whose pid is dead,
//   or that has none (the watcher died between recording the dispatch and the spawn), is settled by its run directory:
//   STATUS `completed` is done; `failed` is a failed attempt, retried later or parked; `suspended` or `running` stays
//   dispatched for 13.3 to adopt or resume, and frees its slot; no `run.json` is a start that was refused, whose
//   reason is the last line of its dispatch log.
// - **A due item**, in queue order: first the lease on its branch, named from its queued title, then the re-check of
//   its ticket through the TicketSource, then the lease on the branch its fresh title names when that differs. The
//   lease comes first because a leased item is skipped on every tick for as long as the lease lasts, and checking it
//   costs no provider call (D6). A leased item stays queued, uses no slot and counts no attempt, and says so with one
//   `queue:skipped_leased` per holder. An item no longer designated or unstarted is dropped.
// - **The start** is recorded before the process exists (`dispatched`, which counts the attempt and names the run),
//   and its pid after (`spawned`, which emits `queue:dispatched`). The run claims its own ticket as it starts (D2): the
//   dispatch only reads the ticket.
// - A port that fails (`PortError`) fails the item without counting an attempt, so trouble at the provider never parks
//   a ticket, and the other due items wait for the next tick. Anything else thrown is a bug, for the caller.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { branchFor } from '../engine/branch';
import { type RunStatus, readStatus } from '../engine/run-dir';
import { RUN_HEADER_FILE } from '../engine/run-header';
import { newRunId } from '../engine/run-id';
import { PortError } from '../ports/errors';
import { getTicket, type TicketSource } from '../ports/ticket-source';
import type { WorkspacePort } from '../ports/workspace';
import type { QueueItem, QueueStore } from './queue-store';
import { dispatchLog, lastLine, type SpawnedRun, type SpawnResumeOptions, type SpawnRunOptions } from './spawn';

/** An item whose run has ended, as the dispatch settled it. */
export interface Settled {
  dedupKey: string;
  ticketKey: string;
  runId: string;
  /** `done`, or a failed attempt: retried at `retryAt`, or parked. */
  outcome: 'done' | 'retry' | 'parked';
  /** Why the attempt failed. */
  reason?: string;
  retryAt?: string;
}

export interface DispatcherOptions {
  workflow: string;
  /** The label the workflow polls: the re-check's designation. */
  label: string;
  maxConcurrentRuns: number;
  branchPrefix: string;
  runsDir: string;
  /** The directory that holds `.sail/`, where runs start. */
  root: string;
  store: QueueStore;
  ticketSource: TicketSource;
  workspace: WorkspacePort;
  /** The environment a run starts in. */
  env: Readonly<Record<string, string>>;
  now: () => Date;
  spawn: (options: SpawnRunOptions) => SpawnedRun;
  /** Starts `sail resume <run>` for a run whose process is gone. */
  resume: (options: SpawnResumeOptions) => SpawnedRun;
  isAlive: (pid: number) => boolean;
  /** Hears each item the dispatch settled, or failed before its run started. */
  onSettled?: (settled: Settled) => void;
  /** Hears a run's process end: the watcher ticks again at once. */
  onExit?: () => void;
}

export interface Dispatcher {
  /** Settles what has ended, then starts what is due within the cap. */
  tick(): Promise<void>;
  /** How many of the workflow's dispatched runs are alive. */
  inFlight(): number;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const { workflow, label, store, ticketSource, workspace, isAlive, now } = options;
  /** The run that held each skipped item's branch when it was last reported. */
  const skipped = new Map<string, string>();
  /** The exit codes of the runs this dispatcher started, by dedup key. */
  const exits = new Map<string, number | null>();

  const alive = (item: QueueItem) => item.pid !== undefined && isAlive(item.pid);
  const dispatchedItems = () => store.snapshot().items.filter((item) => item.state === 'dispatched');
  const inFlight = () => dispatchedItems().filter(alive).length;

  /** Records a failed attempt, or a failure before any, and reports it. */
  const fail = (item: QueueItem, runId: string, reason: string) => {
    const outcome = store.failed(item.dedupKey, reason);
    const retryAt = store.snapshot().items.find((each) => each.dedupKey === item.dedupKey)?.retryAt;
    options.onSettled?.({
      dedupKey: item.dedupKey,
      ticketKey: item.source.ticketKey,
      runId,
      outcome,
      reason,
      ...(outcome === 'retry' && retryAt !== undefined ? { retryAt } : {}),
    });
  };

  const statusOf = (runDir: string): RunStatus | undefined => {
    try {
      return readStatus(runDir);
    } catch {
      return undefined;
    }
  };

  /** Why the start of `item`'s run was refused: its dispatch log's last line, or how its process exited. */
  const refusal = (item: QueueItem, runId: string): string => {
    const line = lastLine(dispatchLog(options.runsDir, workflow, runId));
    if (line !== undefined) return `its start was refused: ${line}`;
    const code = exits.get(item.dedupKey);
    return code === undefined ? 'its start left no run directory' : `its start was refused: it exited ${code}`;
  };

  const settle = () => {
    for (const item of dispatchedItems()) {
      if (alive(item)) continue;
      const runId = item.runId ?? '';
      const runDir = join(options.runsDir, runId);
      if (!existsSync(join(runDir, RUN_HEADER_FILE))) {
        fail(item, runId, refusal(item, runId));
        continue;
      }
      const status = statusOf(runDir);
      if (status?.status === 'completed') {
        store.done(item.dedupKey);
        options.onSettled?.({ dedupKey: item.dedupKey, ticketKey: item.source.ticketKey, runId, outcome: 'done' });
      } else if (status?.status === 'failed') {
        fail(item, runId, `run ${runId} failed (${status.stopReason})`);
      }
      // Suspended or running with its process gone: 13.3 adopts or resumes it. It no longer holds a slot.
    }
  };

  /** Whether a live run holds `branch`, reporting the item as skipped the first time each holder is seen. */
  const leased = async (item: QueueItem, remote: string, branch: string): Promise<boolean> => {
    const holder = await workspace.holder(remote, branch);
    if (holder === undefined) {
      skipped.delete(item.dedupKey);
      return false;
    }
    if (skipped.get(item.dedupKey) !== holder.runId) {
      store.skippedLeased(item.dedupKey, branch, holder.runId);
      skipped.set(item.dedupKey, holder.runId);
    }
    return true;
  };

  /** Whether the item may start now: its branches are free, and its ticket is still designated and unstarted. */
  const eligible = async (item: QueueItem, remote: string): Promise<boolean> => {
    const { ticketKey } = item.source;
    const branch = branchFor(options.branchPrefix, ticketKey, item.title);
    if (await leased(item, remote, branch)) return false;
    const ticket = await getTicket(ticketSource, ticketKey);
    if (!ticketSource.isDesignated(ticket, label)) {
      store.drop(item.dedupKey, `it is not designated: it carries no '${label}' label`);
      return false;
    }
    if (ticket.state.type !== 'unstarted') {
      store.drop(item.dedupKey, `it is ${ticket.state.name}`);
      return false;
    }
    const fresh = branchFor(options.branchPrefix, ticketKey, ticket.title);
    return fresh === branch || !(await leased(item, remote, fresh));
  };

  const start = (item: QueueItem) => {
    const { ticketKey } = item.source;
    const runId = newRunId(ticketKey, now().getTime());
    store.dispatched(item.dedupKey, runId);
    let spawned: SpawnedRun;
    try {
      spawned = options.spawn({
        root: options.root,
        runsDir: options.runsDir,
        workflow,
        ticketKey,
        runId,
        env: options.env,
      });
    } catch (error) {
      fail(item, runId, `its run could not be started: ${messageOf(error)}`);
      return;
    }
    store.spawned(item.dedupKey, spawned.pid);
    void spawned.exited.then((code) => {
      exits.set(item.dedupKey, code);
      options.onExit?.();
    });
  };

  const dispatch = async () => {
    let remote: string | undefined;
    for (const item of store.due()) {
      if (inFlight() >= options.maxConcurrentRuns) return;
      try {
        remote ??= (await workspace.repository()).url;
        if (!(await eligible(item, remote))) continue;
      } catch (error) {
        if (!(error instanceof PortError)) throw error;
        fail(item, item.runId ?? '', `${error.message} (${error.code})`);
        return;
      }
      start(item);
    }
  };

  return {
    async tick() {
      settle();
      await dispatch();
    },
    inFlight,
  };
}
