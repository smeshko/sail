// What the server offers a queue, a queue's items, a workflow and a repository, in the `Offer` shape a run's actions
// already have (actions.ts). An action the server leaves out is not offered; one it gives is `enabled`, or carries `why`
// not. `enabled` and `why` report only what the server checks already: `watching()` for a queue's actions, which is the
// one check behind both these offers and the POSTs that change a queue, and a `.sail/` that still exists for the watch
// set. Read-only.
import { existsSync } from 'node:fs';
import { readConfig } from '../engine/config';
import type { RegistryEntry } from '../watch/registry';
import type { Offer } from './actions';
import { type RunItem, runItems } from './files';
import { type QueueView, queueViews } from './queues';
import { startableWorkflows } from './start';
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

/** What a repository offers: its watch set, each workflow's watch or unwatch, and a start from a ticket or a pull request. */
export interface RepoOffers {
  /** Start a run: the workflows `.sail/workflows/` holds, and the config's `defaultWorkflow` when it reads. */
  start?: Offer & { workflows: string[]; defaultWorkflow?: string };
  watch: Offer;
  unwatch?: Offer;
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

/** The start a repository offers: `offer` for the `.sail/` it needs, with the workflows it can start. */
function startOffer(entry: RegistryEntry, offer: Offer): NonNullable<RepoOffers['start']> {
  if (!existsSync(entry.sailDir)) return { ...offer, workflows: [] };
  let defaultWorkflow: string | undefined;
  try {
    const config = readConfig(entry.sailDir);
    if (!('issues' in config)) defaultWorkflow = config.defaultWorkflow;
  } catch {
    // A config that doesn't read gives no default: the person names the workflow.
  }
  return {
    ...offer,
    workflows: startableWorkflows(entry.sailDir),
    ...(defaultWorkflow === undefined ? {} : { defaultWorkflow }),
  };
}

/** The repository's offers: `watchingWorkflows` is the live watcher's watch set in this clone, empty when none. */
export function repoOffers(
  entry: RegistryEntry,
  queues: readonly QueueView[],
  watchingWorkflows: readonly string[],
): RepoOffers {
  const gone = existsSync(entry.sailDir) ? undefined : `${entry.sailDir} no longer exists`;
  const offer = (): Offer => (gone === undefined ? { enabled: true } : { enabled: false, why: gone });
  const workflows: RepoOffers['workflows'] = Object.create(null) as RepoOffers['workflows'];
  for (const name of watchingWorkflows) workflows[name] = { unwatch: offer() };
  for (const view of queues) if (!(view.workflow in workflows)) workflows[view.workflow] = { watch: offer() };
  const offers: RepoOffers = { watch: offer(), start: startOffer(entry, offer()), workflows };
  if (watchingWorkflows.length > 0) offers.unwatch = offer();
  return offers;
}
