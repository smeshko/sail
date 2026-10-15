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
import type { TicketSource } from '../ports/ticket-source';
import type { WorkspacePort } from '../ports/workspace';
import type { QueueStore } from './queue-store';
import type { SpawnedRun, SpawnRunOptions } from './spawn';

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

export function createDispatcher(_options: DispatcherOptions): Dispatcher {
  return { tick: async () => {}, inFlight: () => 0 };
}
