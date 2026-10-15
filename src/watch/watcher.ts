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
import type { ProjectConfig } from '../engine/config';
import type { TicketSource } from '../ports/ticket-source';
import type { WorkspacePort } from '../ports/workspace';
import type { FormatOptions } from './lines';
import type { Timers } from './poll';
import type { QueuePolicy } from './queue-store';
import type { Holder, IsAlive, RegistryEntry } from './registry';
import type { SpawnedRun, SpawnRunOptions } from './spawn';

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
  isAlive?: IsAlive;
  tickMs?: number;
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
export function holderRefusal(_holder: Holder, _name: string): string {
  return '';
}

export async function startWatcher(_options: WatcherOptions): Promise<Watcher | { refused: string }> {
  return { done: Promise.resolve(), stop: async () => {}, watching: () => [] };
}
