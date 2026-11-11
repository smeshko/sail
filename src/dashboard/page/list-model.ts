// The list's model: the index's repositories (from `listRepos`) turned into the grouped rows each view draws, and the
// counts the sidebar shows. Pure, with no markup. The views are Inbox (what needs attention: runs, parked items and
// problems, from the items it is given), Active (live runs, those that wait on a person first), Queues (one row per
// queue, under its repository) and History (finished runs, one group per start day).

import type { QueueOffers } from '../offers';
import type { Subject } from './action-registry';
import { type AttentionItem, identity } from './attention';
import { dayOf, dayOfMs } from './format';
import { type ListRepo, type ListRun, type ListWorkflow, newestFirst, workflowOf } from './index-model';

export const VIEWS = ['inbox', 'active', 'queues', 'history'] as const;
export type ViewName = (typeof VIEWS)[number];

export interface RunRow {
  kind: 'run';
  /** `run:<repo>/<runId>` */
  id: string;
  repo: string;
  run: ListRun;
}

export interface QueueRow {
  kind: 'queue';
  /** `queue:<repo>/<workflow>` */
  id: string;
  repo: string;
  workflow: string;
  waiting: number;
  /** Its items running, failed and parked, set only above 0. */
  running?: number;
  failed?: number;
  parked?: number;
  lastPolledAt?: string;
  /** Why its poll is paused, and why its dispatch is held. */
  paused?: NonNullable<ListWorkflow['queue']>['paused'];
  held?: NonNullable<ListWorkflow['queue']>['held'];
  /** What the queue offers, for its poll. */
  offers?: QueueOffers;
  /** Why its queue can't be read, listed in place of its waiting count. */
  problem?: string;
  /** Its watch state from the live watcher, with why it isn't watched. */
  watch?: ListWorkflow['watch'];
}

export interface AttentionRow {
  kind: 'attention';
  /** `inbox:<identity>` */
  id: string;
  repo: string;
  item: AttentionItem;
}

export type ListRow = RunRow | QueueRow | AttentionRow;

/** An Inbox row's subject: the run it opens, else its queue's workflow, else its repository. */
export function attentionSubject(row: AttentionRow): Subject {
  const { opens, workflow } = row.item;
  if (opens !== undefined) return { kind: 'run', repo: opens.repo, runId: opens.runId };
  if (workflow !== undefined) return { kind: 'workflow', repo: row.repo, workflow };
  return { kind: 'repo', repo: row.repo };
}

export interface ListGroup {
  /** `<view>:<name>` */
  id: string;
  label: string;
  rows: ListRow[];
  /** The repository a Queues group heads. */
  repo?: ListRepo;
}

/** Live means neither failed nor completed: running, suspended, blocked or unknown. */
export const isLive = (run: ListRun): boolean => run.status !== 'failed' && run.status !== 'completed';
export const isFinished = (run: ListRun): boolean => !isLive(run);
/** A live run that is not running: it waits on a person. */
export const waitsOnPerson = (run: ListRun): boolean => isLive(run) && run.status !== 'running';

const runRow = (repo: string, run: ListRun): RunRow => ({ kind: 'run', id: `run:${repo}/${run.runId}`, repo, run });

/** The runs of every repository that `keep` holds, newest first, as rows. */
function runRows(repos: readonly ListRepo[], keep: (run: ListRun) => boolean): RunRow[] {
  const all = repos.flatMap((repo) => repo.runs.filter(keep).map((run) => ({ ...run, repo: repo.name })));
  return newestFirst(all).map(({ repo, ...run }) => runRow(repo, run));
}

function groupOf(view: ViewName, name: string, label: string, rows: ListRow[]): ListGroup[] {
  return rows.length === 0 ? [] : [{ id: `${view}:${name}`, label, rows }];
}

/** The live runs: those that wait on a person first, then the running ones. An empty group is left out. */
export function activeGroups(repos: readonly ListRepo[]): ListGroup[] {
  return [
    ...groupOf('active', 'waiting', 'waiting on you', runRows(repos, waitsOnPerson)),
    ...groupOf(
      'active',
      'running',
      'running',
      runRows(repos, (run) => run.status === 'running'),
    ),
  ];
}

export interface DayClock {
  /** ms since the epoch */
  now: number;
  /** minutes east of UTC */
  tz: number;
}

/**
 * The finished runs, newest first across statuses, cut into one group per start day at the clock's offset: `Today`,
 * `Yesterday`, then the date. A run with no readable start time goes in a last group.
 */
export function historyGroups(repos: readonly ListRepo[], clock: DayClock): ListGroup[] {
  const today = dayOfMs(clock.now, clock.tz);
  const yesterday = dayOfMs(clock.now - 86_400_000, clock.tz);
  const days = new Map<string, RunRow[]>();
  const undated: RunRow[] = [];
  for (const row of runRows(repos, isFinished)) {
    const day = dayOf(row.run.startedAt, clock.tz);
    if (day === undefined) undated.push(row);
    else days.set(day, [...(days.get(day) ?? []), row]);
  }
  return [
    ...[...days].map(([day, rows]) => ({
      id: `history:${day}`,
      label: day === today ? 'Today' : day === yesterday ? 'Yesterday' : day,
      rows,
    })),
    ...groupOf('history', 'undated', 'no start time', undated),
  ];
}

/** One group per repository, with or without a queue, holding a row per workflow that has one. */
export function queueGroups(repos: readonly ListRepo[]): ListGroup[] {
  return repos.map((repo) => ({
    id: `queues:${repo.name}`,
    label: repo.name,
    repo,
    rows: repo.workflows.flatMap((workflow): QueueRow[] => {
      if (workflow.queue === undefined) return [];
      const row: QueueRow = {
        kind: 'queue',
        id: `queue:${repo.name}/${workflow.name}`,
        repo: repo.name,
        workflow: workflow.name,
        waiting: workflow.queue.waiting ?? 0,
      };
      const { running, failed, parked, lastPolledAt, paused, held, offers } = workflow.queue;
      if (running !== undefined) row.running = running;
      if (failed !== undefined) row.failed = failed;
      if (parked !== undefined) row.parked = parked;
      if (lastPolledAt !== undefined) row.lastPolledAt = lastPolledAt;
      if (paused !== undefined) row.paused = paused;
      if (held !== undefined) row.held = held;
      if (offers !== undefined) row.offers = offers;
      if (workflow.queue.problem !== undefined) row.problem = workflow.queue.problem;
      if (workflow.watch !== undefined) row.watch = workflow.watch;
      return [row];
    }),
  }));
}

/** The needs-attention items as the Inbox's groups: runs, parked items, problems. An empty group is left out. */
export function inboxGroups(items: readonly AttentionItem[]): ListGroup[] {
  const rowsOf = (kinds: readonly AttentionItem['kind'][]): AttentionRow[] =>
    items
      .filter((item) => kinds.includes(item.kind))
      .map((item) => ({ kind: 'attention', id: `inbox:${identity(item)}`, repo: item.repo, item }));
  return [
    ...groupOf('inbox', 'runs', 'runs', rowsOf(['failed', 'error'])),
    ...groupOf('inbox', 'parked', 'parked', rowsOf(['parked'])),
    ...groupOf('inbox', 'problems', 'problems', rowsOf(['problem'])),
  ];
}

/**
 * The view's groups, over `repoFilter`'s repository alone when one is given. `clock` cuts History into days, and
 * `inbox` is the Inbox's items.
 */
export function groupsOf(
  view: ViewName,
  repos: readonly ListRepo[],
  repoFilter: string | undefined,
  clock: DayClock,
  inbox: readonly AttentionItem[] = [],
): ListGroup[] {
  if (view === 'inbox')
    return inboxGroups(repoFilter === undefined ? inbox : inbox.filter((item) => item.repo === repoFilter));
  const kept = repoFilter === undefined ? repos : repos.filter((repo) => repo.name === repoFilter);
  if (view === 'active') return activeGroups(kept);
  if (view === 'history') return historyGroups(kept, clock);
  return queueGroups(kept);
}

const rowText = (row: ListRow): string =>
  row.kind === 'attention'
    ? [row.item.about, row.item.title, row.repo, row.item.workflow, row.item.runId, row.item.key, row.item.detail]
        .filter((part) => part !== undefined)
        .join(' ')
    : row.kind === 'queue'
      ? [row.repo, row.workflow].join(' ')
      : [
          row.run.runId,
          row.run.ticketKey,
          row.run.pr === undefined ? undefined : `PR #${row.run.pr}`,
          row.run.title,
          row.repo,
          workflowOf(row.run),
          row.run.status,
          row.run.stopReason,
        ]
          .filter((part) => part !== undefined)
          .join(' ');

/** The rows whose id, ticket key, title, repository, workflow, status or stop reason holds `text`, in any case. A group left empty goes. */
export function filterRows(groups: readonly ListGroup[], text: string): ListGroup[] {
  const needle = text.trim().toLowerCase();
  if (needle === '') return [...groups];
  return groups.flatMap((group) => {
    const rows = group.rows.filter((row) => rowText(row).toLowerCase().includes(needle));
    return rows.length === 0 ? [] : [{ ...group, rows }];
  });
}

export interface HistoryFilter {
  status?: 'failed' | 'completed' | undefined;
  workflow?: string | undefined;
}

/** The History rows of a status and of a workflow (`name@3` counts as `name`). A group left empty goes. */
export function filterHistory(groups: readonly ListGroup[], filter: HistoryFilter): ListGroup[] {
  const { status, workflow } = filter;
  if (status === undefined && workflow === undefined) return [...groups];
  return groups.flatMap((group) => {
    const rows = group.rows.filter(
      (row) =>
        row.kind === 'run' &&
        (status === undefined || row.run.status === status) &&
        (workflow === undefined || workflowOf(row.run) === workflow),
    );
    return rows.length === 0 ? [] : [{ ...group, rows }];
  });
}

/** The distinct workflows of the finished runs under the repository filter, sorted. */
export function historyWorkflows(repos: readonly ListRepo[], repoFilter?: string): string[] {
  const kept = repoFilter === undefined ? repos : repos.filter((repo) => repo.name === repoFilter);
  const names = kept.flatMap((repo) => repo.runs.filter(isFinished).map(workflowOf));
  return [...new Set(names)].sort();
}

export interface ListFilters {
  repoFilter?: string | undefined;
  listFilter: string;
  historyStatus?: 'failed' | 'completed' | undefined;
  historyWorkflow?: string | undefined;
  tz: number;
}

/** What the list shows: the view's groups under the repository filter, then History's status and workflow, then the text. */
export function shownGroups(
  view: ViewName,
  repos: readonly ListRepo[],
  filters: ListFilters,
  now: number,
  inbox: readonly AttentionItem[] = [],
): ListGroup[] {
  const groups = groupsOf(view, repos, filters.repoFilter, { now, tz: filters.tz }, inbox);
  const narrowed =
    view === 'history'
      ? filterHistory(groups, { status: filters.historyStatus, workflow: filters.historyWorkflow })
      : groups;
  return filterRows(narrowed, filters.listFilter);
}

/** The run rows of `groups` whose id is in `selected`, in list order. */
export function selectedRows(groups: readonly ListGroup[], selected: readonly string[]): RunRow[] {
  return groups.flatMap((group) =>
    group.rows.filter((row): row is RunRow => row.kind === 'run' && selected.includes(row.id)),
  );
}

/** What each view lists under the repository filter: the sidebar's counts. */
export function viewCounts(
  repos: readonly ListRepo[],
  repoFilter?: string,
  inbox: readonly AttentionItem[] = [],
): Record<ViewName, number> {
  const count = (view: ViewName) =>
    groupsOf(view, repos, repoFilter, { now: 0, tz: 0 }, inbox).reduce((sum, group) => sum + group.rows.length, 0);
  return { inbox: count('inbox'), active: count('active'), queues: count('queues'), history: count('history') };
}

/** A repository's dot: broken with a problem, watching while its watcher watches a workflow, else idle. */
export function repoDot(repo: ListRepo): 'broken' | 'watching' | 'idle' {
  if (repo.problem !== undefined) return 'broken';
  return (repo.watching ?? []).length > 0 ? 'watching' : 'idle';
}

/** The cursor's places in order: every group id and the ids of the rows of the groups not folded. */
export function entries(groups: readonly ListGroup[], folded: readonly string[]): string[] {
  return groups.flatMap((group) => [group.id, ...(folded.includes(group.id) ? [] : group.rows.map((row) => row.id))]);
}
