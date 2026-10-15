// The index message, made into what the rail and the queue panel show: every repository with its runs, newest first,
// and every watched workflow's queue. It reads only the index the server streams, which already carries each run's
// summary and each repository's queues, so nothing here opens a run. Nothing here names a stage, a workflow or a
// repository: they all come from the index.
//
// Stub (TASK-005): signatures only.
import type { QueueEvent } from '../../events/types';
import type { QueueItem, QueueItemState } from '../../watch/queue-store';
import type { IndexRepo, RunItem } from '../files';

/** One run as the rail lists it. */
export interface RailRun {
  runId: string;
  workflow?: string;
  ticketKey?: string;
  title?: string;
  status: string;
  stopReason?: string;
  startedAt?: string;
  durationMs?: number;
  costUsd?: number;
  problem?: string;
}

/** One repository as the rail lists it: `live` while any of its runs runs. */
export interface RailRepo {
  name: string;
  remote: string | null;
  problem?: string;
  live: boolean;
  runs: RailRun[];
}

/** The run's status: its STATUS when it can be read, else its summary's, else `unknown`. */
export function statusOf(_run: RunItem): string {
  return 'unknown';
}

/** The run's stop reason, from STATUS or the summary. */
export function stopReasonOf(_run: RunItem): string | undefined {
  return undefined;
}

/** `runs` newest first: by `startedAt`, then by id, both descending. A run with no start time comes last. */
export function newestFirst<T extends { runId: string; startedAt?: string | undefined }>(runs: readonly T[]): T[] {
  return [...runs];
}

/** The rail: every repository by name, each with its runs newest first. `now` is ms since the epoch. */
export function railRepos(_index: readonly IndexRepo[], _now: number): RailRepo[] {
  return [];
}

/** The states in the order the panel lists them. */
export const QUEUE_STATES: readonly QueueItemState[] = ['queued', 'dispatched', 'failed', 'parked', 'done'];

/** A queue item, and whether its run is one the rail lists, so the panel can open it. */
export type PanelItem = QueueItem & { runListed: boolean };

/** One watched workflow's queue in one repository. */
export interface QueuePanel {
  repo: string;
  workflow: string;
  queue?: QueuePanelFile;
  problem?: string;
  counts: Record<QueueItemState, number>;
  items: PanelItem[];
}

export type QueuePanelFile = Omit<NonNullable<IndexRepo['queues'][number]['queue']>, 'items'>;

/** One panel per repository and watched workflow, by repository name. None when no repository has a queue. */
export function queuePanels(_index: readonly IndexRepo[]): QueuePanel[] {
  return [];
}

export type WatchState = 'watched' | 'not watched' | 'unknown';

/** Whether the workflow is in the watch set, from the last `watch:added` or `watch:removed` of its queue's events. */
export function watchState(_events: readonly Pick<QueueEvent, 'type'>[]): WatchState {
  return 'unknown';
}
