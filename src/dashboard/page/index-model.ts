// The index message, made into what the rail and the queue panel show: every repository with its runs, newest first,
// and every watched workflow's queue. It reads only the index the server streams, which already carries each run's
// summary and each repository's queues, so nothing here opens a run. Nothing here names a stage, a workflow or a
// repository: they all come from the index.
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
export function statusOf(run: RunItem): string {
  return run.status?.status ?? run.summary?.status ?? 'unknown';
}

/** The run's stop reason, from STATUS or the summary. */
export function stopReasonOf(run: RunItem): string | undefined {
  return run.status?.stopReason ?? run.summary?.stopReason;
}

/** `runs` newest first: by `startedAt`, then by id, both descending. A run with no start time comes last. */
export function newestFirst<T extends { runId: string; startedAt?: string | undefined }>(runs: readonly T[]): T[] {
  return [...runs].sort((a, b) => {
    if (a.startedAt !== b.startedAt) {
      if (a.startedAt === undefined) return 1;
      if (b.startedAt === undefined) return -1;
      return a.startedAt < b.startedAt ? 1 : -1;
    }
    return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;
  });
}

const byName = <T extends { name: string }>(repos: readonly T[]): T[] =>
  [...repos].sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));

function railRun(run: RunItem, now: number): RailRun {
  const status = statusOf(run);
  const row: RailRun = { runId: run.runId, status };
  const { summary } = run;
  const ticketKey = summary?.source.ticketKey ?? run.source?.ticketKey;
  const startedAt = run.startedAt ?? summary?.startedAt;
  const stopReason = stopReasonOf(run);
  const started = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  const running = status === 'running' && !Number.isNaN(started);
  const durationMs = running ? Math.max(0, now - started) : summary?.durationMs;
  const facts = {
    workflow: run.workflow ?? summary?.workflow,
    ticketKey,
    title: summary?.ticket?.title,
    stopReason,
    startedAt,
    durationMs,
    costUsd: summary?.totals.usage.costUsd,
    problem: run.problem,
  };
  for (const [field, value] of Object.entries(facts)) {
    if (value !== undefined) (row as unknown as Record<string, unknown>)[field] = value;
  }
  return row;
}

/** The rail: every repository by name, each with its runs newest first. `now` is ms since the epoch. */
export function railRepos(index: readonly IndexRepo[], now: number): RailRepo[] {
  return byName(index).map((repo) => {
    const runs = newestFirst(repo.runs.map((run) => railRun(run, now)));
    const rail: RailRepo = {
      name: repo.name,
      remote: repo.remote,
      live: runs.some((run) => run.status === 'running'),
      runs,
    };
    if (repo.problem !== undefined) rail.problem = repo.problem;
    return rail;
  });
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
export function queuePanels(index: readonly IndexRepo[]): QueuePanel[] {
  return byName(index).flatMap((repo) =>
    repo.queues.map((view) => {
      const listed = new Set(repo.runs.map((run) => run.runId));
      const items = QUEUE_STATES.flatMap((state) =>
        (view.queue?.items ?? [])
          .filter((item) => item.state === state)
          .map((item) => ({ ...item, runListed: item.runId !== undefined && listed.has(item.runId) })),
      );
      const counts = Object.fromEntries(
        QUEUE_STATES.map((state) => [state, items.filter((item) => item.state === state).length]),
      ) as Record<QueueItemState, number>;
      const panel: QueuePanel = { repo: repo.name, workflow: view.workflow, counts, items };
      if (view.queue !== undefined) {
        const { items: _, ...file } = view.queue;
        panel.queue = file;
      }
      if (view.problem !== undefined) panel.problem = view.problem;
      return panel;
    }),
  );
}

export type WatchState = 'watched' | 'not watched' | 'unknown';

/** Whether the workflow is in the watch set, from the last `watch:added` or `watch:removed` of its queue's events. */
export function watchState(events: readonly Pick<QueueEvent, 'type'>[]): WatchState {
  const last = events.findLast((event) => event.type === 'watch:added' || event.type === 'watch:removed');
  if (last === undefined) return 'unknown';
  return last.type === 'watch:added' ? 'watched' : 'not watched';
}
