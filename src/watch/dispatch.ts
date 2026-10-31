// One watched workflow's dispatch: each tick settles the items whose run has ended, then starts due items while the
// workflow is under its `maxConcurrentRuns`.
//
// - **In flight** is an item `dispatched` whose pid is alive. Those count against the cap, and so do the workflow's live
//   manual runs: the live runs in this clone that no dispatched item owns, which `liveRuns()` finds once at the top of
//   each tick, by their lease. A run that cannot be counted, because a lease cannot be read, starts and resumes
//   nothing that tick, and is said once. Each tick hands every
//   dispatched item to `reconcile.ts`, which answers by its run directory, its dispatch log and its lease: a live run is
//   in flight, and adopted with `run:adopted` on this dispatcher's first tick, its control file left to it;
//   `completed` is done; `failed stopped` parks the item at once; any other `failed` is a failed attempt, retried later
//   or parked; a dead `running`, or a `suspended interrupted` or `unwatched` run, is resumed once as a detached `sail
//   resume`, with `run:resumed`, after any `unwatched` it never took is taken back, and counts while its resume lives,
//   unless a live process holds its lease, which is adopted instead, or the cap is reached, when it waits for a slot;
//   a resume that leaves the run unended parks the item with why; no `run.json` is a start that was refused, whose
//   reason is the last line of its dispatch log. Anything else, such as `suspended until`, waits for a person, holding
//   no slot.
// - A hand-off file (`engine/control.ts`) the run never took is deleted when its item settles: done, failed or parked.
//   A failure with a `stopped` hand-off, a start refused after `sail stop` reached it, parks the item instead.
// - **A held dispatch**: a run `suspended usage_limit` holds the workflow's dispatch (`queue:held`) until its reset time,
//   or the back-off after it hit the limit; a run `suspended port_unavailable` holds it for the back-off its place in
//   the run of such suspensions calls for (1, 2, 5, 10 then 30 minutes), and is parked, naming the call, the count and
//   the last port error, once it is suspended past that schedule. While held, nothing starts and no run is resumed, and no item's attempt is
//   counted, failed or parked. A tick past the hold releases it (`queue:released`), and the run is resumed with the
//   rest of the dispatch; a run that hits the limit again is held again.
// - **A start whose definitions need a newer sail** (its last log line says so) is neither a failure nor a park: the item
//   goes back to queued with its attempt given back, and the workflow's dispatch is held (`queue:held`, no `until`) by
//   the running sail's SDK fingerprint as it was when the start spawned, which its queue item records, so a restarted
//   watcher holds by it too. The tick that finds the fingerprint changed releases the hold (`queue:released`), so an
//   item whose start spawned before a pull dispatches again on the tick after the hold. `pullBlocked` adds why the watcher can't pull to the hold's reason.
// - **A due pull request**, in queue order: the lease on its queued branch first, then the re-check of the pull request
//   through the CodeHost. One that is closed, merged, a draft, unlabelled, a fork or moved to another sha is dropped
//   with why, and its run starts as `sail '#<n>' --head-sha <sha>`, pinned to the queued sha. It claims nothing.
// - **A due item**, in queue order: first the lease on its branch, named from its queued title, then the re-check of
//   its ticket through the TicketSource, then the lease on the branch its fresh title names when that differs. The
//   lease comes first because a leased item is skipped on every tick for as long as the lease lasts, and checking it
//   costs no provider call (D6). A leased item stays queued, uses no slot and counts no attempt, and says so with one
//   `queue:skipped_leased` per holder. An item whose ticket the re-check doesn't find (`not_found`: deleted, or moved
//   out of the team) is dropped. So is an item no longer designated or in a pick-up state, unless its ticket is started by the
//   claim of this clone's own run that failed (the latest `sail run <id> started` comment): a retry or a requeue must
//   be able to run it again, and that run starts with `--force`. A forced item, added with `--force`, skips the
//   re-check on its first dispatch: only the lease holds it back, and its run starts with `--force`. What `--force`
//   started is that dispatch, so once it has an attempt its retry is re-checked as any item's is, and a ticket another
//   run moved on meanwhile is dropped rather than run a second time.
// - **The start** is recorded before the process exists (`dispatched`, which counts the attempt and names the run),
//   and its pid after (`spawned`, which emits `queue:dispatched`). The run's intake claims the ticket (D2), in `intake#1`:
//   the dispatch only reads the ticket.
// - Any other port that fails (`PortError`) fails the item without counting an attempt, so trouble at the provider
//   never parks a ticket, and the other due items wait for the next tick. A port that fails while a dispatched item is
//   settled leaves that item as it was, says so once, and settles the rest. Anything else thrown is a bug, for the
//   caller.
import { join } from 'node:path';
import { branchFor } from '../engine/branch';
import { cancelUnwatch, dropHandOff, handOffStops } from '../engine/control';
import { getPullRequestDetails } from '../engine/pr-source';
import { readStatus } from '../engine/run-dir';
import { newRunId } from '../engine/run-id';
import { liveRuns } from '../engine/runs';
import { sdkFingerprint } from '../engine/sdk-version';
import { claimedBy } from '../engine/source';
import type { ResumedFrom } from '../events/types';
import type { CodeHost } from '../ports/code-host';
import { PortError } from '../ports/errors';
import { holdsLabel } from '../ports/labels';
import { getTicket, type TicketSource } from '../ports/ticket-source';
import type { Ticket } from '../ports/types';
import type { WorkspacePort } from '../ports/workspace';
import type { QueueItem, QueueStore } from './queue-store';
import { type Reconciled, reconcileItem } from './reconcile';
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
  /** How long a usage limit holds the dispatch when the run names no reset time. */
  usageLimitBackoffMs: number;
  /** How long a run suspended on an unavailable port holds the dispatch, by consecutive suspension; one past the end parks. */
  portUnavailableBackoffMs: readonly number[];
  spawn: (options: SpawnRunOptions) => SpawnedRun;
  /** Starts `sail resume <run>` for a run whose process is gone. */
  resume: (options: SpawnResumeOptions) => SpawnedRun;
  isAlive: (pid: number) => boolean;
  /** Hears each item the dispatch settled, or failed before its run started. */
  onSettled?: (settled: Settled) => void;
  /** Hears a dispatched item that could not be settled, once per item and message. */
  onError?: (message: string) => void;
  /** Hears a run's process end: the watcher ticks again at once. */
  onExit?: () => void;
  /** Whether the dispatch is paused, as while the config names a model no harness runs: nothing starts or resumes. */
  paused?: () => boolean;
  /** The running sail's SDK fingerprint: a hold for definitions that need a newer sail lasts until it changes. */
  sail?: () => string;
  /** Why the watcher can't bring the clone to a newer sail itself, said in that hold's reason; undefined when it can. */
  pullBlocked?: () => string | undefined;
  /** Hears the dispatch hold for definitions that need a newer sail: the watcher may fast-forward the clone at once. */
  onHeld?: () => void;
}

export interface Dispatcher {
  /** Settles what has ended, then starts what is due within the cap. */
  tick(): Promise<void>;
  /** How many of the workflow's dispatched runs are alive. The live manual runs, which also fill the cap, are not in it. */
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
  /** The message reported for each dispatched item that could not be settled, until it settles again. */
  const unsettled = new Map<string, string>();
  /** The exit codes of the processes this dispatcher started, a run or a resume, by dedup key. */
  const exits = new Map<string, number | null>();
  /** Where the output of the process this dispatcher last started begins in its dispatch log, by dedup key. */
  const logFroms = new Map<string, number>();
  /** The runs this dispatcher has resumed: each is resumed once. */
  const resumed = new Set<string>();
  /** When this dispatcher last resumed each run from its usage limit or an unavailable port, until the run is held again. */
  const resumedAt = new Map<string, Date>();
  /** When this dispatcher last resumed each run, whatever from: dates the `error:crash` its resume left. */
  const resumeStartedAt = new Map<string, Date>();
  /** When this dispatcher first saw each run on its usage limit or an unavailable port, until it resumes the run. */
  const limitedAt = new Map<string, Date>();
  const sail = options.sail ?? sdkFingerprint;
  /** Until the first settle is over: a live run found then is adopted. */
  let first = true;

  /** Whether a usage limit holds the dispatch now, or definitions that need a newer sail while the running sail is unchanged. */
  const holding = (): boolean => {
    const { held } = store.snapshot();
    if (held === undefined) return false;
    if (held.sail !== undefined) return sail() === held.sail;
    return held.until !== undefined && now().getTime() < Date.parse(held.until);
  };

  const alive = (item: QueueItem) => item.pid !== undefined && isAlive(item.pid);
  const dispatchedItems = () => store.snapshot().items.filter((item) => item.state === 'dispatched');
  const inFlight = () => dispatchedItems().filter(alive).length;

  /** The live runs of the workflow that no dispatched item owns, this tick; undefined when they could not be counted. */
  let manual: number | undefined;
  /** The message reported for the live runs that could not be counted, until they are counted again. */
  let uncounted: string | undefined;
  const full = () => manual === undefined || inFlight() + manual >= options.maxConcurrentRuns;

  const countManual = async () => {
    try {
      const owned = new Set(dispatchedItems().map((item) => item.runId));
      const live = await liveRuns(options.runsDir, workflow, { workspace, isAlive });
      manual = live.filter((runId) => !owned.has(runId)).length;
      uncounted = undefined;
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      manual = undefined;
      const message = `the live runs of ${workflow} were not counted: ${error.message} (${error.code})`;
      if (uncounted !== message) {
        uncounted = message;
        options.onError?.(message);
      }
    }
  };

  /** Records a failed attempt, or a failure before any, and reports it: parked instead, when a stop waits in the hand-off. */
  const fail = (item: QueueItem, runId: string, reason: string) => {
    if (handOffStops(options.runsDir, runId)) {
      park(item, runId, `run ${runId} was stopped: ${reason}`);
      return;
    }
    dropHandOff(options.runsDir, runId);
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
    if (from.status === 'suspended' && (from.stopReason === 'usage_limit' || from.stopReason === 'port_unavailable')) {
      resumedAt.set(runId, now());
    }
    resumeStartedAt.set(runId, now());
    exits.delete(item.dedupKey);
    let spawned: SpawnedRun;
    try {
      spawned = options.resume({ root: options.root, runsDir: options.runsDir, workflow, runId, env: options.env });
    } catch (error) {
      park(item, runId, `its resume could not be started: ${messageOf(error)}`);
      return;
    }
    logFroms.set(item.dedupKey, spawned.logFrom);
    store.resumed(item.dedupKey, spawned.pid, from);
    watchExit(item, spawned);
  };

  const park = (item: QueueItem, runId: string, reason: string) => {
    dropHandOff(options.runsDir, runId);
    store.parked(item.dedupKey, reason);
    options.onSettled?.({
      dedupKey: item.dedupKey,
      ...sourceOf(item),
      runId,
      outcome: 'parked',
      reason,
    });
  };

  /** Reconciles one dispatched item, or undefined when a port failed: the item stays as it was, and is reported once. */
  const reconcile = async (item: QueueItem) => {
    const runId = item.runId ?? '';
    const exited = exits.get(item.dedupKey);
    const logFrom = logFroms.get(item.dedupKey);
    try {
      const answer = await reconcileItem(item, {
        runsDir: options.runsDir,
        workflow,
        isAlive,
        workspace,
        now: now(),
        backoffMs: options.usageLimitBackoffMs,
        portBackoffMs: options.portUnavailableBackoffMs,
        ...(limitedAt.has(runId) ? { limitedAt: limitedAt.get(runId) as Date } : {}),
        first,
        resumed: resumed.has(runId),
        ...(resumedAt.has(runId) ? { resumedAt: resumedAt.get(runId) as Date } : {}),
        ...(resumeStartedAt.has(runId) ? { resumeStartedAt: resumeStartedAt.get(runId) as Date } : {}),
        ...(exits.has(item.dedupKey) ? { exited: exited ?? null } : {}),
        ...(logFrom === undefined ? {} : { logFrom }),
      });
      unsettled.delete(item.dedupKey);
      return answer;
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      const message = `${item.dedupKey} was not settled: ${error.message} (${error.code})`;
      if (unsettled.get(item.dedupKey) !== message) {
        unsettled.set(item.dedupKey, message);
        options.onError?.(message);
      }
      return undefined;
    }
  };

  const apply = (item: QueueItem, answer: Reconciled) => {
    const runId = item.runId ?? '';
    const runDir = join(options.runsDir, runId);
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
        dropHandOff(options.runsDir, runId);
        store.done(item.dedupKey);
        options.onSettled?.({ dedupKey: item.dedupKey, ...sourceOf(item), runId, outcome: 'done' });
        break;
      case 'failed':
        fail(item, runId, answer.reason);
        break;
      case 'park':
        park(item, runId, answer.reason);
        break;
      case 'outdated': {
        // The start never ran, so its attempt is given back; the hold ends when the running sail's SDK changes.
        dropHandOff(options.runsDir, runId);
        store.deferred(item.dedupKey);
        const blocked = options.pullBlocked?.();
        store.holdForSail(
          item.sail ?? sail(),
          runId,
          blocked === undefined ? answer.reason : `${answer.reason} (the watcher can't: ${blocked})`,
        );
        options.onHeld?.();
        break;
      }
      case 'held':
        // The run will be resumed once, and again if it is held again, so it is not one this dispatcher resumed.
        resumed.delete(runId);
        resumedAt.delete(runId);
        limitedAt.set(runId, limitedAt.get(runId) ?? now());
        store.hold(answer.until, runId, answer.reason);
        break;
      case 'resume':
        if (holding() || options.paused?.() === true) break;
        // A resume takes a slot as a start does: over the cap, as after the cap was lowered, it waits a tick.
        if (full()) break;
        // Watched again: an `unwatched` the dead run never took would suspend its resume at once. Nothing else writes
        // to a dead run's control file: `sail stop` ends a run it finds dead itself.
        cancelUnwatch(runDir);
        limitedAt.delete(runId);
        resume(item, runId, answer.from);
        break;
      case 'wait':
        break;
    }
  };

  const settle = async () => {
    try {
      for (const item of dispatchedItems()) {
        const answer = await reconcile(item);
        if (answer !== undefined) apply(item, answer);
      }
    } finally {
      first = false;
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
          : !holdsLabel(pr.labels, label)
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

  /** Whether the ticket is started, and the run its latest claim comment names is one of this clone's that failed. */
  const ownClaim = (ticket: Ticket): boolean => {
    if (ticket.state.type !== 'started') return false;
    const runId = claimedBy(ticket);
    if (runId === undefined) return false;
    try {
      return readStatus(join(options.runsDir, runId)).status === 'failed';
    } catch {
      return false;
    }
  };

  /**
   * Whether the item may start now, and whether its run must be forced: its branches are free, and its ticket is still
   * designated and in a pick-up state, or started by this clone's own failed run, which a forced start takes over. A forced
   * item skips the re-check until its first dispatch.
   */
  const eligible = async (item: QueueItem, remote: string): Promise<false | { force: boolean }> => {
    if (item.source.kind === 'pr') return (await eligiblePullRequest(item, item.source, remote)) && { force: false };
    const { ticketKey } = item.source;
    const branch = branchFor(options.branchPrefix, ticketKey, item.title);
    if (await leased(item, remote, branch)) return false;
    if (item.forced === true && item.attempts === 0) return { force: true };
    let ticket: Awaited<ReturnType<typeof getTicket>>;
    try {
      ticket = await getTicket(ticketSource, ticketKey);
    } catch (error) {
      if (!(error instanceof PortError && error.code === 'not_found')) throw error;
      store.drop(item.dedupKey, `it no longer exists: ${error.message}`);
      return false;
    }
    if (!ticketSource.isDesignated(ticket, label)) {
      store.drop(item.dedupKey, `it is not designated: it carries no '${label}' label`);
      return false;
    }
    const own = ownClaim(ticket);
    if (!ticketSource.canPickUp(ticket) && !own) {
      store.drop(item.dedupKey, `it is ${ticket.state.name}`);
      return false;
    }
    const fresh = branchFor(options.branchPrefix, ticketKey, ticket.title);
    return (fresh === branch || !(await leased(item, remote, fresh))) && { force: own };
  };

  const start = (item: QueueItem, force: boolean) => {
    const { source } = item;
    const runId = newRunId(source.kind === 'pr' ? `pr-${source.number}` : source.ticketKey, now().getTime());
    store.dispatched(item.dedupKey, runId, sail());
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
        ...(item.forced === true || force ? { force: true } : {}),
      });
    } catch (error) {
      fail(item, runId, `its run could not be started: ${messageOf(error)}`);
      return;
    }
    logFroms.set(item.dedupKey, spawned.logFrom);
    store.spawned(item.dedupKey, spawned.pid);
    watchExit(item, spawned);
  };

  const dispatch = async () => {
    if (holding() || options.paused?.() === true) return;
    let remote: string | undefined;
    for (const item of store.due()) {
      if (full()) return;
      let answer: false | { force: boolean };
      try {
        remote ??= (await workspace.repository()).url;
        answer = await eligible(item, remote);
      } catch (error) {
        if (!(error instanceof PortError)) throw error;
        fail(item, item.runId ?? '', `${error.message} (${error.code})`);
        return;
      }
      if (answer) start(item, answer.force);
    }
  };

  return {
    async tick() {
      if (store.snapshot().held !== undefined && !holding()) store.release();
      await countManual();
      await settle();
      await dispatch();
    },
    inFlight,
  };
}
