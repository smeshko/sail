// Polling: each watched workflow's designated tickets, on a timer of its own, into its queue.
// Stubbed for queue-store-and-polling: TASK-005 writes it.
import type { ProjectConfig } from '../engine/config';
import type { TicketSource } from '../ports/ticket-source';
import type { Command } from './inbox';
import type { QueuePolicy, QueueStore } from './queue-store';

/** One watched workflow, ready to poll. */
export interface WatchTarget {
  workflow: string;
  label: string;
  everyMs: number;
  ticketSource: TicketSource;
  store: QueueStore;
}

export interface OpenWatchTargetOptions {
  sailDir: string;
  config: Pick<ProjectConfig, 'label'>;
  /** The workflow's name. */
  name: string;
  ticketSource: TicketSource;
  now: () => Date;
  policy?: QueuePolicy;
}

/** Loads workflow `name` and opens its queue. A workflow that won't load, or isn't watched, refuses. */
export async function openWatchTarget(_options: OpenWatchTargetOptions): Promise<WatchTarget | { refused: string }> {
  return { refused: 'not opened yet' };
}

export type PollOutcome = 'polled' | 'failed' | 'paused';

/** Polls `target` once into its queue, and says how it went. */
export async function pollOnce(_target: WatchTarget, _now: () => Date, _policy?: QueuePolicy): Promise<PollOutcome> {
  return 'failed';
}

/** How the poller waits: `setTimeout` for the watcher, a fake in tests. */
export interface Timers {
  set(fn: () => unknown, ms: number): unknown;
  clear(handle: unknown): void;
}

export const systemTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Poller {
  /** Polls every target at once, then keeps each on its own timer. */
  start(): Promise<void>;
  /** Clears every timer. A poll in flight is still recorded, and not rescheduled. */
  stop(): void;
  /** Polls the workflow now, paused or not, or joins its poll in flight. A workflow it doesn't poll throws. */
  pollNow(workflow: string): Promise<PollOutcome>;
  /** Applies a command from the inbox. One for a workflow it doesn't poll throws. */
  apply(command: Command): void;
}

export interface PollerOptions {
  targets: readonly WatchTarget[];
  timers: Timers;
  now: () => Date;
  policy?: QueuePolicy;
}

export function createPoller(_options: PollerOptions): Poller {
  return {
    async start() {},
    stop() {},
    pollNow: async () => 'failed',
    apply() {},
  };
}
