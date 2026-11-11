// The list's model: the index's repositories (from `listRepos`) turned into the grouped rows each view draws, and the
// counts the sidebar shows. Pure, with no markup. The views are Active (live runs, those that wait on a person first),
// Queues (one row per queue, under its repository) and History (finished runs, failed then done).
import { type ListRepo, type ListRun, newestFirst, workflowOf } from './index-model';

export const VIEWS = ['active', 'queues', 'history'] as const;
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
  lastPolledAt?: string;
}

export type ListRow = RunRow | QueueRow;

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

/** The finished runs, failed then done, newest first. */
export function historyGroups(repos: readonly ListRepo[]): ListGroup[] {
  return [
    ...groupOf(
      'history',
      'failed',
      'failed',
      runRows(repos, (run) => run.status === 'failed'),
    ),
    ...groupOf(
      'history',
      'done',
      'done',
      runRows(repos, (run) => run.status === 'completed'),
    ),
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
        waiting: workflow.queue.waiting,
      };
      if (workflow.queue.lastPolledAt !== undefined) row.lastPolledAt = workflow.queue.lastPolledAt;
      return [row];
    }),
  }));
}

/** The view's groups, over `repoFilter`'s repository alone when one is given. */
export function groupsOf(view: ViewName, repos: readonly ListRepo[], repoFilter?: string): ListGroup[] {
  const kept = repoFilter === undefined ? repos : repos.filter((repo) => repo.name === repoFilter);
  if (view === 'active') return activeGroups(kept);
  if (view === 'history') return historyGroups(kept);
  return queueGroups(kept);
}

const rowText = (row: ListRow): string =>
  row.kind === 'queue'
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

/** What each view lists under the repository filter: the sidebar's counts. */
export function navCounts(repos: readonly ListRepo[], repoFilter?: string): Record<ViewName, number> {
  const count = (view: ViewName) =>
    groupsOf(view, repos, repoFilter).reduce((sum, group) => sum + group.rows.length, 0);
  return { active: count('active'), queues: count('queues'), history: count('history') };
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
