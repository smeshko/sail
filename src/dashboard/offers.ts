// What the server offers a queue, a queue's items, a workflow and a repository, in the `Offer` shape a run's actions
// already have (actions.ts). An action the server leaves out is not offered; one it gives is `enabled`, or carries `why`
// not. `enabled` and `why` report only what the server checks already: `watching()` for a queue's actions, which is the
// one check behind both these offers and the POSTs that change a queue, and a `.sail/` that still exists for the watch
// set. Read-only.
import { existsSync } from 'node:fs';
import type { RegistryEntry } from '../watch/registry';
import type { Offer } from './actions';
import { type RunItem, runItems } from './files';
import { type QueueView, queueViews } from './queues';
import { type RepoWatcher, repoWatcher, workflowWatch } from './watch-state';

/** What one queue item offers: only the actions that apply to its state. */
export interface ItemOffers {
  requeue?: Offer;
  drop?: Offer;
  move?: Offer;
}

/** What a queue offers: poll and add always, and each item's actions by its dedup key. */
export interface QueueOffers {
  poll: Offer;
  add: Offer;
  items: Record<string, ItemOffers>;
}

/** The failed runs a clean of every failed run of the repository takes, each with the queue item that names it. */
export type CleanAllOffer = Offer & {
  runs: { runId: string; item?: { workflow: string; dedupKey: string; state: string } }[];
};

/** What a repository offers: its watch set, its clean of every failed run, and each workflow's watch or unwatch. */
export interface RepoOffers {
  watch: Offer;
  unwatch?: Offer;
  /** Left out when the repository has no failed run. The runs are listed unchecked: the clean refuses each in its own line. */
  clean?: CleanAllOffer;
  workflows: Record<string, { watch?: Offer; unwatch?: Offer }>;
}

/** A queue with what it offers. */
export type OfferedQueue = QueueView & { offers?: QueueOffers };

/**
 * The repository's live watcher when it runs in this clone and watches `workflow`, with how to name it and the label it
 * polls the workflow on, or why not: the workflow's watch state (watch-state.ts), so an offer, a refusal and the state
 * the page shows give one reason. `read` is the watcher as already read, read here when not given.
 */
export function watching(
  entry: RegistryEntry,
  workflow: string,
  read: RepoWatcher = repoWatcher(entry),
): { named: string; label: string } | { refused: string } {
  const watch = workflowWatch(entry, workflow, read);
  return watch.state === 'watched' ? { named: watch.named, label: watch.label } : { refused: watch.why };
}

/** The offers of one queue: `liveRunIds` are the runs that are running or suspended, to tell a failed item's run has ended. */
export function queueOffers(
  entry: RegistryEntry,
  view: QueueView,
  liveRunIds: ReadonlySet<string>,
  read: RepoWatcher = repoWatcher(entry),
): QueueOffers {
  const watched = watching(entry, view.workflow, read);
  const offer: Offer = 'refused' in watched ? { enabled: false, why: watched.refused } : { enabled: true };
  const items: Record<string, ItemOffers> = Object.create(null) as Record<string, ItemOffers>;
  for (const item of view.queue?.items ?? []) {
    const offers: ItemOffers = {};
    const ended = item.runId === undefined || !liveRunIds.has(item.runId);
    if (item.state === 'parked' || (item.state === 'failed' && ended)) offers.requeue = { ...offer };
    if (item.state !== 'dispatched') offers.drop = { ...offer };
    if (item.state === 'queued') offers.move = { ...offer };
    items[item.dedupKey] = offers;
  }
  return { poll: { ...offer }, add: { ...offer }, items };
}

/** The repository's queues, each with its offers. `runs` are its runs and `read` its watcher, read when not given. */
export function offeredQueues(entry: RegistryEntry, runs?: readonly RunItem[], read?: RepoWatcher): OfferedQueue[] {
  const views = queueViews(entry);
  if (views.length === 0) return [];
  const all = runs ?? runItems(entry);
  const live = new Set(
    all
      .filter((run) => ['running', 'suspended'].includes(run.status?.status ?? run.summary?.status ?? 'unknown'))
      .map((run) => run.runId),
  );
  const watcher = read ?? repoWatcher(entry);
  return views.map((view) => ({ ...view, offers: queueOffers(entry, view, live, watcher) }));
}

/**
 * The repository's offers: `watchingWorkflows` is the live watcher's watch set in this clone, empty when none, and
 * `runs` its runs, whose failed ones a clean of every failed run takes. The runs are not checked one by one here: a
 * check can reach the code host, and this is read every second.
 */
export function repoOffers(
  entry: RegistryEntry,
  queues: readonly QueueView[],
  watchingWorkflows: readonly string[],
  runs: readonly Pick<RunItem, 'runId' | 'status'>[] = [],
): RepoOffers {
  const gone = existsSync(entry.sailDir) ? undefined : `${entry.sailDir} no longer exists`;
  const offer = (): Offer => (gone === undefined ? { enabled: true } : { enabled: false, why: gone });
  const workflows: RepoOffers['workflows'] = Object.create(null) as RepoOffers['workflows'];
  for (const name of watchingWorkflows) workflows[name] = { unwatch: offer() };
  for (const view of queues) if (!(view.workflow in workflows)) workflows[view.workflow] = { watch: offer() };
  const offers: RepoOffers = { watch: offer(), workflows };
  if (watchingWorkflows.length > 0) offers.unwatch = offer();
  const failed = runs.filter((run) => run.status?.status === 'failed');
  if (failed.length > 0) {
    offers.clean = {
      ...offer(),
      runs: failed.map((run) => {
        for (const view of queues) {
          const named = view.queue?.items.find((each) => each.runId === run.runId);
          if (named !== undefined) {
            return {
              runId: run.runId,
              item: { workflow: view.workflow, dedupKey: named.dedupKey, state: named.state },
            };
          }
        }
        return { runId: run.runId };
      }),
    };
  }
  return offers;
}
