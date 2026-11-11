// The index message, made into what the rail and the queue view show: every repository with its workflows, each with its
// runs newest first and its queue's waiting count, and every watched workflow's queue. It reads only the index the server streams, which already carries each run's
// summary and each repository's queues, so nothing here opens a run. Nothing here names a stage, a workflow or a
// repository: they all come from the index.
import type { QueueItem, QueueItemState } from '../../watch/queue-store';
import type { IndexRepo, RunItem } from '../files';
import type { QueueWatch, WatchState } from '../watch-state';

/** One run as the rail lists it. */
export interface RailRun {
  runId: string;
  workflow?: string;
  ticketKey?: string;
  /** The pull request's number, for a run started from a pull request. */
  pr?: number;
  title?: string;
  status: string;
  stalled?: string;
  stopReason?: string;
  startedAt?: string;
  durationMs?: number;
  costUsd?: number;
  problem?: string;
}

/** One workflow of a repository as the rail lists it: its runs newest first, its queue when it has one, and the change of the watch set it offers. */
export interface RailWorkflow {
  name: string;
  runs: RailRun[];
  queue?: { waiting: number; lastPolledAt?: string };
  /**
   * Its watch state from the live watcher, with why it isn't watched: its queue view's, else `watched` while it is in the
   * watch set, else none for a workflow with runs alone.
   */
  watch?: { state: WatchState; why?: string };
  /** `unwatch` while its state is `watched`, `watch` for the other two states, none without a state. */
  toggle?: 'watch' | 'unwatch';
}

/** One repository as the rail lists it: `live` while any of its runs runs, and its runs by workflow. */
export interface RailRepo {
  name: string;
  remote: string | null;
  problem?: string;
  live: boolean;
  runs: RailRun[];
  workflows: RailWorkflow[];
  /** The workflows the repository's live watcher watches, or absent while none runs in this clone. */
  watching?: string[];
}

/** The workflow a run ran, without its version: `name@3` is `name`. A run that names none is `unknown`. */
export function workflowOf(run: Pick<RailRun, 'workflow'>): string {
  return run.workflow?.replace(/@\d+$/, '') || 'unknown';
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
  // A pull-request run has no ticket key: its rail entry reads its pull request's number.
  const keyOf = (source: { kind: string; ticketKey?: string } | undefined) =>
    source?.kind === 'ticket' ? source.ticketKey : undefined;
  const ticketKey = keyOf(summary?.source) ?? keyOf(run.source);
  const prOf = (source: { kind: string; number?: number } | undefined) =>
    source?.kind === 'pr' ? source.number : undefined;
  const pr = prOf(summary?.source) ?? prOf(run.source);
  const startedAt = run.startedAt ?? summary?.startedAt;
  const stopReason = stopReasonOf(run);
  const started = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  const running = status === 'running' && !Number.isNaN(started);
  const durationMs = running ? Math.max(0, now - started) : summary?.durationMs;
  const facts = {
    workflow: run.workflow ?? summary?.workflow,
    ticketKey,
    pr,
    title: summary?.ticket?.title,
    stopReason,
    startedAt,
    durationMs,
    costUsd: summary?.totals.usage.costUsd,
    problem: run.problem,
    stalled: status === 'running' ? summary?.stalled?.[0]?.key : undefined,
  };
  for (const [field, value] of Object.entries(facts)) {
    if (value !== undefined) (row as unknown as Record<string, unknown>)[field] = value;
  }
  return row;
}

/** A repository's workflows by name: those its runs ran and those it has a queue for. */
function workflows(repo: IndexRepo, runs: readonly RailRun[]): RailWorkflow[] {
  const watched = repo.watching?.workflows ?? [];
  const names = new Set([...runs.map(workflowOf), ...repo.queues.map((view) => view.workflow), ...watched]);
  return byName([...names].map((name) => ({ name }))).map(({ name }) => {
    const workflow: RailWorkflow = { name, runs: runs.filter((run) => workflowOf(run) === name) };
    const view = repo.queues.find((each) => each.workflow === name);
    if (view !== undefined) {
      const waiting = (view.queue?.items ?? []).filter((item) => item.state === 'queued').length;
      const polled = view.queue?.polling.lastPolledAt;
      workflow.queue = polled === undefined ? { waiting } : { waiting, lastPolledAt: polled };
    }
    if (view !== undefined) workflow.watch = view.watch.state === 'watched' ? { state: 'watched' } : view.watch;
    else if (watched.includes(name)) workflow.watch = { state: 'watched' };
    if (workflow.watch !== undefined) workflow.toggle = workflow.watch.state === 'watched' ? 'unwatch' : 'watch';
    return workflow;
  });
}

/** The rail: every repository by name, each with its runs newest first, also by workflow. `now` is ms since the epoch. */
export function railRepos(index: readonly IndexRepo[], now: number): RailRepo[] {
  return byName(index).map((repo) => {
    const runs = newestFirst(repo.runs.map((run) => railRun(run, now)));
    const rail: RailRepo = {
      name: repo.name,
      remote: repo.remote,
      live: runs.some((run) => run.status === 'running'),
      runs,
      workflows: workflows(repo, runs),
    };
    if (repo.problem !== undefined) rail.problem = repo.problem;
    if (repo.watching !== undefined) rail.watching = repo.watching.workflows;
    return rail;
  });
}

/** The states in the order the queue view lists them: what is running now comes first. */
export const QUEUE_STATES: readonly QueueItemState[] = ['dispatched', 'queued', 'failed', 'parked', 'done'];

/** A queue item, whether its run is one the rail lists so the queue view can open it, and whether that run has ended. */
export type PanelItem = QueueItem & { runListed: boolean; runEnded: boolean };

/** One watched workflow's queue in one repository. */
export interface QueuePanel {
  repo: string;
  workflow: string;
  queue?: QueuePanelFile;
  problem?: string;
  counts: Record<QueueItemState, number>;
  items: PanelItem[];
  /** The workflow's watch state from the live watcher, and why it isn't watched. */
  watch: QueueWatch;
}

export type QueuePanelFile = Omit<NonNullable<IndexRepo['queues'][number]['queue']>, 'items'>;

/** One panel per repository and watched workflow, by repository name. None when no repository has a queue. */
export function queuePanels(index: readonly IndexRepo[]): QueuePanel[] {
  return byName(index).flatMap((repo) =>
    repo.queues.map((view) => {
      const listed = new Set(repo.runs.map((run) => run.runId));
      const live = new Set(
        repo.runs.filter((run) => ['running', 'suspended'].includes(statusOf(run))).map((run) => run.runId),
      );
      const items = QUEUE_STATES.flatMap((state) =>
        (view.queue?.items ?? [])
          .filter((item) => item.state === state)
          .map((item) => ({
            ...item,
            runListed: item.runId !== undefined && listed.has(item.runId),
            runEnded: item.runId === undefined || !live.has(item.runId),
          })),
      );
      const counts = Object.fromEntries(
        QUEUE_STATES.map((state) => [state, items.filter((item) => item.state === state).length]),
      ) as Record<QueueItemState, number>;
      const panel: QueuePanel = { repo: repo.name, workflow: view.workflow, counts, items, watch: view.watch };
      if (view.queue !== undefined) {
        const { items: _, ...file } = view.queue;
        panel.queue = file;
      }
      if (view.problem !== undefined) panel.problem = view.problem;
      return panel;
    }),
  );
}

/** What the workflow polls, from the last `queue:polled` event of its queue's events. */
export function pollKind(events: readonly { type: string }[]): 'ticket' | 'pr' | undefined {
  const kind = (events.findLast((event) => event.type === 'queue:polled') as { kind?: unknown } | undefined)?.kind;
  return kind === 'ticket' || kind === 'pr' ? kind : undefined;
}
