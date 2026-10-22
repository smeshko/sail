// One watched workflow's dispatch: each tick settles the items whose run has ended, then starts due items while the
// workflow is under its `maxConcurrentRuns`.
//
// - **In flight** is an item `dispatched` whose pid is alive. Only those count against the cap. Each tick hands every
//   dispatched item to `reconcile.ts`, which answers by its run directory, its dispatch log and its lease: a live run is
//   in flight, and adopted with `run:adopted` on this dispatcher's first tick, its control file left to it;
//   `completed` is done; `failed stopped` parks the item at once; any other `failed` is a failed attempt, retried later
//   or parked; a dead `running`, or a `suspended interrupted` or `unwatched` run, is resumed once as a detached `sail
//   resume`, with `run:resumed`, after any `unwatched` it never took is taken back, and counts while its resume lives,
//   unless a live process holds its lease, which is adopted instead, or the cap is reached, when it waits for a slot;
//   a resume that leaves the run unended parks the item with why; no `run.json` is a start that was refused, whose
//   reason is the last line of its dispatch log. Anything else, such as `suspended until`, waits for a person, holding
//   no slot.
// - **A due pull request**, in queue order: the lease on its queued branch first, then the re-check of the pull request
//   through the CodeHost. One that is closed, merged, a draft, unlabelled, a fork or moved to another sha is dropped
//   with why, and its run starts as `sail '#<n>' --head-sha <sha>`, pinned to the queued sha. It claims nothing.
// - **A due item**, in queue order: first the lease on its branch, named from its queued title, then the re-check of
//   its ticket through the TicketSource, then the lease on the branch its fresh title names when that differs. The
//   lease comes first because a leased item is skipped on every tick for as long as the lease lasts, and checking it
//   costs no provider call (D6). A leased item stays queued, uses no slot and counts no attempt, and says so with one
//   `queue:skipped_leased` per holder. An item no longer designated or unstarted is dropped. A forced item, added with
//   `--force`, skips the re-check: only the lease holds it back, and its run starts with `--force`.
// - **The start** is recorded before the process exists (`dispatched`, which counts the attempt and names the run),
//   and its pid after (`spawned`, which emits `queue:dispatched`). The run claims its own ticket as it starts (D2): the
//   dispatch only reads the ticket.
// - A port that fails (`PortError`) fails the item without counting an attempt, so trouble at the provider never parks
//   a ticket, and the other due items wait for the next tick. Anything else thrown is a bug, for the caller.
import { join } from 'node:path';
import { branchFor } from '../engine/branch';
import { cancelUnwatch } from '../engine/control';
import { getPullRequestDetails } from '../engine/pr-source';
import { newRunId } from '../engine/run-id';
import type { ResumedFrom } from '../events/types';
import type { CodeHost } from '../ports/code-host';
import { PortError } from '../ports/errors';
import { getTicket, type TicketSource } from '../ports/ticket-source';
import type { WorkspacePort } from '../ports/workspace';
import type { QueueItem, QueueStore } from './queue-store';
import { reconcileItem } from './reconcile';
import type { SpawnedRun, SpawnResumeOptions, SpawnRunOptions } from './spawn';

/** An item whose run has ended, as the dispatch settled it. */
export interface Settled {
  dedupKey: string;
  /** The item's ticket, for a ticket item. */
  ticketKey?: string;
  /** The item's pull request at its head sha, for a pull-request item. */
  pr?: { number: number; headSha: string };
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
  /** Re-checks a queued pull request before its run starts. */
  codeHost: CodeHost;
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

/** What a settled item names: its ticket, or its pull request at its head sha. */
const sourceOf = (item: QueueItem): Pick<Settled, 'ticketKey' | 'pr'> =>
  item.source.kind === 'ticket'
    ? { ticketKey: item.source.ticketKey }
    : { pr: { number: item.source.number, headSha: item.source.headSha } };

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const { workflow, label, store, ticketSource, codeHost, workspace, isAlive, now } = options;
  /** The run that held each skipped item's branch when it was last reported. */
  const skipped = new Map<string, string>();
  /** The exit codes of the processes this dispatcher started, a run or a resume, by dedup key. */
  const exits = new Map<string, number | null>();
  /** The runs this dispatcher has resumed: each is resumed once. */
  const resumed = new Set<string>();
  /** Until the first settle is over: a live run found then is adopted. */
  let first = true;

  const alive = (item: QueueItem) => item.pid !== undefined && isAlive(item.pid);
  const dispatchedItems = () => store.snapshot().items.filter((item) => item.state === 'dispatched');
  const inFlight = () => dispatchedItems().filter(alive).length;

  /** Records a failed attempt, or a failure before any, and reports it. */
  const fail = (item: QueueItem, runId: string, reason: string) => {
    const outcome = store.failed(item.dedupKey, reason);
    const retryAt = store.snapshot().items.find((each) => each.dedupKey === item.dedupKey)?.retryAt;
    options.onSettled?.({
      dedupKey: item.dedupKey,
      ...sourceOf(item),
      runId,
      outcome,
      reason,
      ...(outcome === 'retry' && retryAt !== undefined ? { retryAt } : {}),
    });
  };

  /** Hears the process started for `item` end: its code is kept for the item's reason, and the watcher ticks. */
  const watchExit = (item: QueueItem, spawned: SpawnedRun) => {
    void spawned.exited.then((code) => {
      exits.set(item.dedupKey, code);
      options.onExit?.();
    });
  };

  /** Resumes the item's run as a process of its own, once, which then counts as the item's. */
  const resume = (item: QueueItem, runId: string, from: ResumedFrom) => {
    resumed.add(runId);
    exits.delete(item.dedupKey);
    let spawned: SpawnedRun;
    try {
      spawned = options.resume({ root: options.root, runsDir: options.runsDir, workflow, runId, env: options.env });
    } catch (error) {
      park(item, runId, `its resume could not be started: ${messageOf(error)}`);
      return;
    }
    store.resumed(item.dedupKey, spawned.pid, from);
    watchExit(item, spawned);
  };

  const park = (item: QueueItem, runId: string, reason: string) => {
    store.parked(item.dedupKey, reason);
    options.onSettled?.({
      dedupKey: item.dedupKey,
      ...sourceOf(item),
      runId,
      outcome: 'parked',
      reason,
    });
  };

  const settle = async () => {
    for (const item of dispatchedItems()) {
      const runId = item.runId ?? '';
      const runDir = join(options.runsDir, runId);
      const exited = exits.get(item.dedupKey);
      const answer = await reconcileItem(item, {
        runsDir: options.runsDir,
        workflow,
        isAlive,
        workspace,
        first,
        resumed: resumed.has(runId),
        ...(exits.has(item.dedupKey) ? { exited: exited ?? null } : {}),
      });
      switch (answer.kind) {
        case 'in-flight':
          // A live run's control file is left to the run: taking an `unwatched` back from under it could take a stop
          // that replaced it meanwhile. One it never reached suspends it, and the next tick resumes it.
          if (answer.adopt && item.pid !== undefined) store.adopted(item.dedupKey, item.pid);
          break;
        case 'adopt':
          store.adopted(item.dedupKey, answer.pid);
          break;
        case 'done':
          store.done(item.dedupKey);
          options.onSettled?.({ dedupKey: item.dedupKey, ...sourceOf(item), runId, outcome: 'done' });
          break;
        case 'failed':
          fail(item, runId, answer.reason);
          break;
        case 'park':
          park(item, runId, answer.reason);
          break;
        case 'resume':
          // A resume takes a slot as a start does: over the cap, as after the cap was lowered, it waits a tick.
          if (inFlight() >= options.maxConcurrentRuns) break;
          // Watched again: an `unwatched` the dead run never took would suspend its resume at once. Nothing else writes
          // to a dead run's control file: `sail stop` ends a run it finds dead itself.
          cancelUnwatch(runDir);
          resume(item, runId, answer.from);
          break;
        case 'wait':
          break;
      }
    }
    first = false;
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

  /**
   * Whether a pull-request item may start now: its branch is free, from the queue alone, and a re-check finds the pull
   * request still designated at the queued sha (D10). One that isn't is dropped, with why.
   */
  const eligiblePullRequest = async (
    item: QueueItem,
    source: Extract<QueueItem['source'], { kind: 'pr' }>,
    remote: string,
  ): Promise<boolean> => {
    if (await leased(item, remote, source.branch)) return false;
    const pr = await getPullRequestDetails(codeHost, source.number);
    const why =
      pr.state !== 'open'
        ? `it is ${pr.state}`
        : pr.draft
          ? 'it is a draft'
          : !pr.labels.includes(label)
            ? `it is not designated: it carries no '${label}' label`
            : pr.fork
              ? 'it comes from a fork'
              : pr.headSha !== source.headSha
                ? `its head moved to ${pr.headSha.slice(0, 7)}: the next poll queues it`
                : undefined;
    if (why === undefined) return true;
    store.drop(item.dedupKey, why);
    return false;
  };

  /** Whether the item may start now: its branches are free, and its ticket is still designated and unstarted. */
  const eligible = async (item: QueueItem, remote: string): Promise<boolean> => {
    if (item.source.kind === 'pr') return eligiblePullRequest(item, item.source, remote);
    const { ticketKey } = item.source;
    const branch = branchFor(options.branchPrefix, ticketKey, item.title);
    if (await leased(item, remote, branch)) return false;
    if (item.forced === true) return true;
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
    const { source } = item;
    const runId = newRunId(source.kind === 'pr' ? `pr-${source.number}` : source.ticketKey, now().getTime());
    store.dispatched(item.dedupKey, runId);
    let spawned: SpawnedRun;
    try {
      spawned = options.spawn({
        root: options.root,
        runsDir: options.runsDir,
        workflow,
        ...(source.kind === 'pr'
          ? { pr: { number: source.number, headSha: source.headSha } }
          : { ticketKey: source.ticketKey }),
        runId,
        env: options.env,
        ...(item.forced === true ? { force: true } : {}),
      });
    } catch (error) {
      fail(item, runId, `its run could not be started: ${messageOf(error)}`);
      return;
    }
    store.spawned(item.dedupKey, spawned.pid);
    watchExit(item, spawned);
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
      await settle();
      await dispatch();
    },
    inFlight,
  };
}
