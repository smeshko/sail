// The watcher: one repository's watch set, held in memory, each workflow in it polled and dispatched, until the set
// empties or the watcher is told to stop (ADR-0019).
//
// It starts in this order: it opens every workflow it is asked to watch, refusing on the first that refuses and on
// two that poll one label; it empties its inbox, so a command a stopped watcher left changes nothing; it records
// itself in its repository's registry entry, refusing when a live watcher holds its name or one of its labels; and
// only then does each workflow get its `watch:added`, a poller of its own and a dispatcher. Its inbox is emptied
// before it is live because a second `sail watch` drops its command only once it sees a live watcher in the registry.
//
// A tick every second, never two at once, drains the inbox, asks `checkConfig()` whether the config can be dispatched
// on, then runs each workflow's dispatch in the order the set was formed: one the config can't be dispatched on settles
// what ended but starts and resumes nothing. A run's process ending asks for a tick at once. The commands:
// - `watch`: opens the workflows not watched yet, refuses a label the set or another watcher already polls, records
//   the new labels, and adds them. Watched already, it changes nothing.
// - `unwatch`: asks each live run of the workflow to suspend at its next call boundary, through its control file, then
//   stops the workflow's poller and dispatch and emits its `watch:removed`. Its queue is kept, and a later `watch` of it
//   resumes those runs, then dispatches from the queue. An empty set stops the watcher.
// - `poll`: polls a watched workflow now. One outside the set is rejected.
// - `add`, `requeue` and `drop`: a change to a watched workflow's queue by hand, each safe to apply twice. `add` checks
//   the ticket as a start does, designated and in a pick-up state unless forced, and queues it, forced when it was. `requeue`
//   puts a parked or failed item back as queued, unless its last run has not ended: that run still holds the branch.
//   `drop` takes out any item but a dispatched one, whose run has not been settled. One outside the set is rejected.
// A rejected command prints its reason, and the set stays as it was.
//
// Stopping, on an empty set or on Ctrl-C, stops every poller and the tick, emits `watch:removed` for what is left,
// clears the registry field and resolves `done`. Runs in flight carry on: they are detached, and the watcher's own
// stop asks nothing of them. Only an `unwatch` command does.
//
// Once its first workflows are added, a starting watcher sweeps the worktrees of ended runs (`workspace.sweep()`): a
// completed or failed run whose worktree was left behind, as when its release failed. Runs that are running,
// suspended or interrupted keep theirs. It is the one slow git step in the watcher's own process, and rare.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isAlive as processIsAlive, releaseLease, takeLease } from '../adapters/leases';
import { DEFAULT_BRANCH_PREFIX } from '../engine/branch';
import type { ProjectConfig } from '../engine/config';
import { requestUnwatch } from '../engine/control';
import { readStatus, runsDir as runsDirOf } from '../engine/run-dir';
import { resolveSource } from '../engine/source';
import type { QueueEvent } from '../events/types';
import type { CodeHost } from '../ports/code-host';
import { sameLabel } from '../ports/labels';
import type { TicketSource } from '../ports/ticket-source';
import type { WorkspacePort } from '../ports/workspace';
import { createDispatcher, type Dispatcher } from './dispatch';
import { type Command, clearCommands, drainCommands } from './inbox';
import {
  errorLine,
  type FormatOptions,
  formatLines,
  queueLine,
  setLine,
  settledLine,
  suspendLine,
  sweptLine,
  type WatchLine,
} from './lines';
import { createPoller, openWatchTarget, type Poller, type Timers, type WatchTarget } from './poll';
import { DEFAULT_QUEUE_POLICY, dedupKey, type QueueItem, type QueuePolicy } from './queue-store';
import { liveHolder } from './reconcile';
import {
  claimWatcher,
  clearWatcher,
  type Holder,
  type IsAlive,
  keepWatcher,
  type RegistryEntry,
  ticketSourceKey,
  type WatcherFields,
} from './registry';
import { type SpawnedRun, type SpawnResumeOptions, type SpawnRunOptions, spawnResume, spawnRun } from './spawn';

/**
 * Where a watcher leases its repository's queues, under `.sail-runs/`: the branch leases' file protocol, keyed by
 * `QUEUE_LEASE`, held while the watcher runs and stale once its pid is dead. It is what keeps two watchers of one
 * `.sail/` apart when they start at the same instant, which the registry's read-back can't (both write one entry).
 */
export const QUEUE_LEASE_DIR = '.watcher';
const QUEUE_LEASE = { remote: 'watcher', branch: 'queue' } as const;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * How long, in real time, adding a workflow waits for its first poll unless told otherwise. A provider that doesn't
 * answer by then can't hold up the tick a `watch` command is applied in: the poll goes on, and records its answer
 * when it comes.
 */
export const FIRST_POLL_MS = 10_000;

/** Waits for `promise`, for at most `ms` of real time. */
async function atMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([promise, waited]);
  clearTimeout(timer);
}

/** How often the watcher ticks unless told otherwise. */
export const TICK_MS = 1000;

export interface WatcherOptions {
  sailDir: string;
  config: ProjectConfig;
  adapters: { ticketSource: TicketSource; codeHost: CodeHost; workspace: WorkspacePort };
  /** The repository's registry entry, as `repositoryEntry()` builds it: the watcher adds its field to it. */
  entry: RegistryEntry;
  registryDir: string;
  /** The workflows to watch from the start. */
  workflows: readonly string[];
  /** The environment the dispatched runs start in. */
  env: Readonly<Record<string, string>>;
  now: () => Date;
  timers: Timers;
  spawn?: (options: SpawnRunOptions) => SpawnedRun;
  /** Starts `sail resume <run>`: `spawnResume` when left out. */
  resume?: (options: SpawnResumeOptions) => SpawnedRun;
  isAlive?: IsAlive;
  tickMs?: number;
  /** How long adding a workflow waits for its first poll: `FIRST_POLL_MS` when left out. */
  firstPollMs?: number;
  /** Receives each formatted line. */
  write: (text: string) => void;
  lines?: FormatOptions;
  policy?: QueuePolicy;
  /** The pid the watcher records itself under: this process's when left out. */
  pid?: number;
  /**
   * Why the config can't be dispatched on now, such as a model alias its harness can't run, or undefined when it can.
   * Asked at every tick: while it answers a reason, nothing starts or resumes, and the reason is printed once.
   */
  checkConfig?: () => Promise<string | undefined>;
}

export interface Watcher {
  /** Resolves once the watcher has stopped. */
  done: Promise<void>;
  /** Stops it, after the tick in flight. */
  stop(): Promise<void>;
  /** The watch set, in the order it was formed. */
  watching(): string[];
}

/** Why an add for `workflow` is refused: it polls pull requests, and an add queues a ticket. */
export function addsNoTicket(workflow: string): string {
  return `workflow '${workflow}' polls pull requests: only a workflow that polls tickets takes an add`;
}

/** Why a watcher can't start, or can't take a label, when `holder` is in its way. */
export function holderRefusal(holder: Holder, name: string): string {
  const { watcher } = holder;
  const clone = dirname(watcher.sailDir);
  if (holder.kind === 'label') {
    return `the label '${holder.label}' on the ${watcher.ticketSource} ticket source is polled by the watcher of '${holder.entry.name}' in ${clone} (pid ${watcher.pid})`;
  }
  const where = holder.kind === 'here' ? 'here' : `in ${clone}`;
  return `a watcher for '${name}' already runs ${where} (pid ${watcher.pid}, since ${watcher.startedAt})`;
}

interface Watched {
  target: WatchTarget;
  poller: Poller;
  dispatcher: Dispatcher;
}

export async function startWatcher(options: WatcherOptions): Promise<Watcher | { refused: string }> {
  const { sailDir, config, timers, now, policy } = options;
  const { ticketSource, codeHost, workspace } = options.adapters;
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const tickMs = options.tickMs ?? TICK_MS;
  const runs = runsDirOf(sailDir);
  const startedAt = now().toISOString();
  const format = formatLines(options.lines);
  const print = (line: WatchLine | undefined) => {
    if (line !== undefined) options.write(format(line));
  };
  /** The workflows whose last poll failed, so the next one that succeeds says so. */
  const failing = new Set<string>();
  const onEvent = (event: QueueEvent) => {
    print(queueLine(event, failing.has(event.workflow)));
    if (event.type === 'queue:error') failing.add(event.workflow);
    if (event.type === 'queue:polled') failing.delete(event.workflow);
  };

  const set = new Map<string, Watched>();
  const watching = () => [...set.keys()];
  /** The ticket labels of `targets`: the registry claims those alone, since a pull request's lives in its code host. */
  const labelsOf = (targets: readonly WatchTarget[]) => [
    ...new Set(targets.filter((target) => target.kind === 'ticket').map((target) => target.label)),
  ];
  const watchedTargets = () => [...set.values()].map((watched) => watched.target);

  /** Opens the workflows of `names` not watched yet, refusing on one that refuses, or on two that poll one label. */
  const open = async (names: readonly string[]): Promise<WatchTarget[] | { refused: string }> => {
    const targets: WatchTarget[] = [];
    for (const name of new Set(names)) {
      if (set.has(name)) continue;
      const target = await openWatchTarget({
        sailDir,
        config,
        name,
        ticketSource,
        codeHost,
        now,
        onEvent,
        ...(policy ? { policy } : {}),
      });
      if ('refused' in target) return target;
      targets.push(target);
    }
    const all = [...watchedTargets(), ...targets];
    // One label per kind: a ticket workflow and a pull-request workflow may both poll `sail`, which is the hand-over.
    // A pull request's label matches whatever its case, so `sail` and `Sail` are one label to two pull-request workflows.
    const clash = (a: WatchTarget, b: WatchTarget) =>
      a.kind === b.kind && (a.kind === 'pr' ? sameLabel(a.label, b.label) : a.label === b.label);
    for (const [index, target] of all.entries()) {
      const other = all.slice(0, index).find((each) => clash(each, target));
      if (other !== undefined) {
        return {
          refused: `workflows '${other.workflow}' and '${target.workflow}' both poll the label '${target.label}'`,
        };
      }
    }
    return targets;
  };

  /** The fields the watcher last recorded itself with. */
  let recorded: WatcherFields | undefined;
  /** Records the watcher with `labels`, or gives the refusal of what holds one of them. */
  const claim = (labels: string[]): string | undefined => {
    const fields = {
      pid,
      startedAt,
      sailDir: options.entry.sailDir,
      ticketSource: ticketSourceKey(ticketSource),
      labels,
    };
    const claimed = claimWatcher(options.registryDir, options.entry, fields, isAlive);
    if ('holder' in claimed) return holderRefusal(claimed.holder, options.entry.name);
    recorded = fields;
    return undefined;
  };
  /**
   * Why the watcher must stop, when it no longer holds its registry field alone: another live watcher of this
   * repository holds the field (two started at once, and it won), or another repository's took one of its labels while
   * the field was wrong.
   */
  const lost = (): string | undefined => {
    if (recorded === undefined) return undefined;
    const kept = keepWatcher(options.registryDir, options.entry, recorded, isAlive);
    if ('lost' in kept) {
      return `another watcher of '${options.entry.name}' runs here (pid ${kept.lost.pid}), recorded after this one: this one stops`;
    }
    if ('holder' in kept) return `${holderRefusal(kept.holder, options.entry.name)}: this watcher stops`;
    return undefined;
  };

  let stopped = false;
  /** Why the config can't be dispatched on, as `checkConfig()` last answered. */
  let configProblem: string | undefined;
  /** Asks `checkConfig()` again, and prints a line when its answer changed. */
  const recheck = async () => {
    if (options.checkConfig === undefined) return;
    let problem: string | undefined;
    try {
      problem = await options.checkConfig();
    } catch (error) {
      problem = `the config can't be checked: ${messageOf(error)}`;
    }
    if (problem !== configProblem) {
      print(
        problem === undefined
          ? { at: now(), text: 'dispatch resumed: the config can be dispatched on again' }
          : errorLine(undefined, `dispatch paused until the config is fixed: ${problem}`, now()),
      );
    }
    configProblem = problem;
  };
  /** Gives back the queues' lease: set once it is taken. */
  let release: (() => void) | undefined;
  let timer: unknown;
  let ticking: Promise<void> | undefined;
  let again = false;
  let resolveDone = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer !== undefined) timers.clear(timer);
    timer = timers.set(() => {
      timer = undefined;
      return tick();
    }, ms);
  };
  /** A run ended: tick at once, or right after the tick in flight. */
  const kick = () => {
    if (ticking === undefined) schedule(0);
    else again = true;
  };

  const add = async (target: WatchTarget) => {
    const { workflow } = target;
    target.store.watched({ pid, everyMs: target.everyMs, maxConcurrentRuns: target.maxConcurrentRuns });
    const poller = createPoller({
      targets: [target],
      timers,
      now,
      ...(policy ? { policy } : {}),
      onError: (_, error) => print(errorLine(workflow, error, now())),
    });
    const dispatcher = createDispatcher({
      workflow,
      usageLimitBackoffMs: (policy ?? DEFAULT_QUEUE_POLICY).usageLimitBackoffMs,
      label: target.label,
      maxConcurrentRuns: target.maxConcurrentRuns,
      branchPrefix: config.branchPrefix ?? DEFAULT_BRANCH_PREFIX,
      runsDir: runs,
      root: dirname(sailDir),
      store: target.store,
      ticketSource,
      codeHost,
      workspace,
      env: options.env,
      now,
      spawn: options.spawn ?? spawnRun,
      resume: options.resume ?? spawnResume,
      isAlive,
      onSettled: (settled) => print(settledLine(workflow, settled, now())),
      onError: (message) => print(errorLine(workflow, message, now())),
      onExit: kick,
      paused: () => configProblem !== undefined,
    });
    set.set(workflow, { target, poller, dispatcher });
    await atMost(poller.start(), options.firstPollMs ?? FIRST_POLL_MS);
  };

  /**
   * Takes `workflow` out of the set. Its poller is dropped, so a poll still waiting on the provider records nothing:
   * this workflow's queue store is let go, and a later `watch` of it, or the next watcher, opens the queue afresh.
   */
  const remove = (workflow: string) => {
    const watched = set.get(workflow);
    if (watched === undefined) return;
    set.delete(workflow);
    watched.poller.drop();
    watched.target.store.unwatched(pid);
  };

  /**
   * Asks each live run of `workflow` to suspend at its next call boundary, saying so for each request written. A run
   * still starting has no directory to take a request from, and nothing asks it again once the workflow leaves the set:
   * that is said as an alert naming `sail stop`, so the person knows it runs on.
   */
  const suspendRuns = async (workflow: string) => {
    const watched = set.get(workflow);
    if (watched === undefined) return;
    for (const item of watched.target.store.snapshot().items) {
      if (item.state !== 'dispatched' || item.runId === undefined) continue;
      // Alive as the process the item records, or as a live holder of its lease, such as a resume started by hand
      // since: commands are applied before the tick that would adopt it.
      const alive =
        (item.pid !== undefined && isAlive(item.pid)) ||
        (await liveHolder(join(runs, item.runId), item.runId, { workspace, isAlive })) !== undefined;
      if (!alive) continue;
      let written: boolean;
      try {
        written = requestUnwatch(join(runs, item.runId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const why = `run ${item.runId} is still starting and was not asked to suspend: sail stop ${item.runId} stops it`;
        print(errorLine(workflow, why, now()));
        continue;
      }
      if (written) print(suspendLine(workflow, item.dedupKey, item.runId, now()));
    }
  };

  const finish = () => {
    if (stopped) return;
    stopped = true;
    try {
      if (timer !== undefined) timers.clear(timer);
      for (const workflow of watching()) {
        try {
          remove(workflow);
        } catch (error) {
          print(errorLine(workflow, error, now()));
        }
      }
      clearWatcher(options.registryDir, options.entry.name, pid);
    } finally {
      try {
        release?.();
      } finally {
        resolveDone();
      }
    }
  };

  /** The status of the run `runId`, `<status>[ <stop reason>]`, or undefined when it has none. */
  const runStatus = (runId: string): { status: string; said: string } | undefined => {
    try {
      const { status, stopReason } = readStatus(join(runs, runId));
      return { status, said: stopReason === undefined ? status : `${status} ${stopReason}` };
    } catch {
      return undefined;
    }
  };

  /** Applies a queue command to the watched workflow `target`'s queue, or throws why it can't. */
  const edit = async (target: WatchTarget, command: Extract<Command, { op: 'add' | 'requeue' | 'drop' | 'move' }>) => {
    const { store } = target;
    const itemOf = (key: string): QueueItem | undefined => store.snapshot().items.find((item) => item.dedupKey === key);
    if (command.op === 'add') {
      if (target.kind !== 'ticket') throw new Error(addsNoTicket(target.workflow));
      const force = command.force === true;
      const resolved = await resolveSource({ ref: command.ticketKey, ticketSource, label: target.label, force });
      if ('refused' in resolved) throw new Error(resolved.refused);
      const taken = itemOf(dedupKey({ kind: 'ticket', ticketKey: resolved.ticketKey }));
      if (taken !== undefined && taken.state !== 'done') return;
      store.add([resolved.ticket], { forced: force });
      return;
    }
    if (command.op === 'move') {
      const to = command.before !== undefined ? { before: command.before } : { after: command.after ?? '' };
      store.move(command.dedupKey, to, 'moved by hand');
      return;
    }
    const item = itemOf(command.dedupKey);
    if (command.op === 'drop') {
      if (item === undefined) return;
      if (item.state === 'dispatched') {
        const runId = item.runId ?? '';
        throw new Error(`${item.dedupKey} can't be dropped: its run ${runId} has not ended: sail stop ${runId} first`);
      }
      store.drop(item.dedupKey, 'dropped by hand');
      return;
    }
    if (item === undefined) throw new Error(`${target.workflow}'s queue has no item ${command.dedupKey}`);
    if (item.state === 'queued') return;
    const run = item.runId === undefined ? undefined : runStatus(item.runId);
    if (
      (item.state === 'parked' || item.state === 'failed') &&
      (run?.status === 'suspended' || run?.status === 'running')
    ) {
      const runId = item.runId ?? '';
      throw new Error(
        `${item.dedupKey} can't be requeued: its run ${runId} is ${run.said}, and holds its branch: sail resume ${runId} or sail stop ${runId} first`,
      );
    }
    store.requeue(item.dedupKey, 'requeued by hand');
  };

  const apply = async (command: Command) => {
    if (stopped) throw new Error('the watcher is stopping');
    if (command.op === 'poll') {
      const watched = set.get(command.workflow);
      if (watched === undefined) throw new Error(`not watching workflow '${command.workflow}'`);
      watched.poller.apply(command);
      return;
    }
    if (command.op === 'watch') {
      const targets = await open(command.workflows);
      if ('refused' in targets) throw new Error(targets.refused);
      if (targets.length === 0) return;
      const refused = claim(labelsOf([...watchedTargets(), ...targets]));
      if (refused !== undefined) throw new Error(refused);
      for (const target of targets) await add(target);
      print(setLine(watching(), now()));
      return;
    }
    if (command.op === 'add' || command.op === 'requeue' || command.op === 'drop' || command.op === 'move') {
      const watched = set.get(command.workflow);
      if (watched === undefined) throw new Error(`not watching workflow '${command.workflow}'`);
      await edit(watched.target, command);
      return;
    }
    const leaving = command.workflows.filter((workflow) => set.has(workflow));
    if (leaving.length === 0) return;
    for (const workflow of leaving) {
      await suspendRuns(workflow);
      remove(workflow);
    }
    // An empty set stops the watcher once the whole drain is applied, so a `watch` dropped after this command still
    // counts: the set it leaves is the one that decides.
    if (set.size === 0) return;
    print(setLine(watching(), now()));
    claim(labelsOf(watchedTargets()));
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (ticking !== undefined) {
      again = true;
      return ticking;
    }
    ticking = (async () => {
      try {
        const why = lost();
        if (why !== undefined) {
          print(errorLine(undefined, why, now()));
          finish();
          return;
        }
        const drained = await drainCommands(runs, apply);
        for (const rejected of drained.rejected) print(errorLine(undefined, rejected.reason, now()));
        if (set.size === 0) {
          print(setLine([], now()));
          finish();
          return;
        }
        await recheck();
        for (const [workflow, watched] of [...set]) {
          if (stopped) break;
          try {
            await watched.dispatcher.tick();
          } catch (error) {
            print(errorLine(workflow, error, now()));
          }
        }
      } catch (error) {
        print(errorLine(undefined, error, now()));
      }
    })();
    await ticking;
    ticking = undefined;
    const soon = again;
    again = false;
    schedule(soon ? 0 : tickMs);
  };

  // The queues are leased before any of them is opened, so a second watcher here never reads or writes one.
  const leaseDir = join(runs, QUEUE_LEASE_DIR);
  const holder = { runId: `watcher-${pid}`, runDir: leaseDir, pid };
  let leased: ReturnType<typeof takeLease>;
  try {
    leased = takeLease(leaseDir, QUEUE_LEASE.remote, QUEUE_LEASE.branch, holder, now());
  } catch (error) {
    return { refused: `the watcher's lease in ${leaseDir} can't be taken: ${messageOf(error)}` };
  }
  if (!leased.leased) {
    const { pid: held, takenAt } = leased.holder;
    return { refused: `a watcher for '${options.entry.name}' already runs here (pid ${held}, since ${takenAt})` };
  }
  release = () => {
    releaseLease(leaseDir, QUEUE_LEASE.remote, QUEUE_LEASE.branch, holder.runId);
  };
  const refuse = (refusal: { refused: string }) => {
    release?.();
    return refusal;
  };
  try {
    const targets = await open(options.workflows);
    if ('refused' in targets) return refuse(targets);
    if (targets.length === 0) return refuse({ refused: 'name at least one workflow to watch' });
    clearCommands(runs);
    const refused = claim(labelsOf(targets));
    if (refused !== undefined) return refuse({ refused });
    for (const target of targets) await add(target);
    print(setLine(watching(), now()));
    try {
      const swept = await workspace.sweep(runs);
      if (swept.paths.length > 0) print(sweptLine(swept.paths.length, now()));
      for (const { path, reason } of swept.failed) {
        const result = existsSync(path) ? 'was not removed' : 'was removed, but its release failed';
        print(errorLine(undefined, `the worktree ${path} of an ended run ${result}: ${reason}`, now()));
      }
    } catch (error) {
      print(errorLine(undefined, `the worktrees of ended runs were not swept: ${messageOf(error)}`, now()));
    }
    schedule(tickMs);
  } catch (error) {
    try {
      finish();
    } catch {
      // Cleanup must not replace the error that prevented startup.
    }
    throw error;
  }

  return {
    done,
    async stop() {
      if (ticking !== undefined) await ticking;
      finish();
    },
    watching,
  };
}
