// The watcher: one repository's watch set, held in memory, each workflow in it polled and dispatched, until the set
// empties or the watcher is told to stop (ADR-0019).
//
// It starts in this order: it opens every workflow it is asked to watch, refusing on the first that refuses and on
// two that poll one label; it empties its inbox, so a command a stopped watcher left changes nothing; it records
// itself in its repository's registry entry, refusing when a live watcher holds its name or one of its labels; and
// only then does each workflow get its `watch:added`, a poller of its own and a dispatcher. Its inbox is emptied
// before it is live because a second `sail watch` drops its command only once it sees a live watcher in the registry.
//
// A tick every second, never two at once, drains the inbox, then runs each workflow's dispatch in the order the set was
// formed. A run's process ending asks for a tick at once. The commands:
// - `watch`: opens the workflows not watched yet, refuses a label the set or another watcher already polls, records
//   the new labels, and adds them. Watched already, it changes nothing.
// - `unwatch`: stops a workflow's poller and dispatch, emits its `watch:removed`, and leaves its runs running. An
//   empty set stops the watcher.
// - `poll`: polls a watched workflow now. One outside the set is rejected.
// A rejected command prints its reason, and the set stays as it was.
//
// Stopping, on an empty set or on Ctrl-C, stops every poller and the tick, emits `watch:removed` for what is left,
// clears the registry field and resolves `done`. Runs in flight carry on: they are detached.
import { dirname, join } from 'node:path';
import { isAlive as processIsAlive, releaseLease, takeLease } from '../adapters/leases';
import { DEFAULT_BRANCH_PREFIX } from '../engine/branch';
import type { ProjectConfig } from '../engine/config';
import { runsDir as runsDirOf } from '../engine/run-dir';
import type { QueueEvent } from '../events/types';
import type { TicketSource } from '../ports/ticket-source';
import type { WorkspacePort } from '../ports/workspace';
import { createDispatcher, type Dispatcher } from './dispatch';
import { type Command, clearCommands, drainCommands } from './inbox';
import { errorLine, type FormatOptions, formatLines, queueLine, setLine, settledLine, type WatchLine } from './lines';
import { createPoller, openWatchTarget, type Poller, type Timers, type WatchTarget } from './poll';
import type { QueuePolicy } from './queue-store';
import {
  claimWatcher,
  clearWatcher,
  type Holder,
  type IsAlive,
  keepWatcher,
  type RegistryEntry,
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
  adapters: { ticketSource: TicketSource; workspace: WorkspacePort };
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
}

export interface Watcher {
  /** Resolves once the watcher has stopped. */
  done: Promise<void>;
  /** Stops it, after the tick in flight. */
  stop(): Promise<void>;
  /** The watch set, in the order it was formed. */
  watching(): string[];
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
  const { ticketSource, workspace } = options.adapters;
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
  const labelsOf = (targets: readonly WatchTarget[]) => [...new Set(targets.map((target) => target.label))];
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
        now,
        onEvent,
        ...(policy ? { policy } : {}),
      });
      if ('refused' in target) return target;
      targets.push(target);
    }
    const all = [...watchedTargets(), ...targets];
    for (const [index, target] of all.entries()) {
      const other = all.slice(0, index).find((each) => each.label === target.label);
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
    const fields = { pid, startedAt, sailDir: options.entry.sailDir, ticketSource: ticketSource.name, labels };
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
      label: target.label,
      maxConcurrentRuns: target.maxConcurrentRuns,
      branchPrefix: config.branchPrefix ?? DEFAULT_BRANCH_PREFIX,
      runsDir: runs,
      root: dirname(sailDir),
      store: target.store,
      ticketSource,
      workspace,
      env: options.env,
      now,
      spawn: options.spawn ?? spawnRun,
      resume: options.resume ?? spawnResume,
      isAlive,
      onSettled: (settled) => print(settledLine(workflow, settled, now())),
      onExit: kick,
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

  const finish = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) timers.clear(timer);
    for (const workflow of watching()) remove(workflow);
    clearWatcher(options.registryDir, options.entry.name, pid);
    release?.();
    resolveDone();
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
    if (command.op !== 'unwatch') throw new Error(`the watcher can't ${command.op} yet`);
    const leaving = command.workflows.filter((workflow) => set.has(workflow));
    if (leaving.length === 0) return;
    for (const workflow of leaving) remove(workflow);
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
  const targets = await open(options.workflows);
  if ('refused' in targets) return refuse(targets);
  if (targets.length === 0) return refuse({ refused: 'name at least one workflow to watch' });
  clearCommands(runs);
  const refused = claim(labelsOf(targets));
  if (refused !== undefined) return refuse({ refused });
  for (const target of targets) await add(target);
  print(setLine(watching(), now()));
  schedule(tickMs);

  return {
    done,
    async stop() {
      if (ticking !== undefined) await ticking;
      finish();
    },
    watching,
  };
}
