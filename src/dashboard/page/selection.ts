// Which row the centre shows without being asked. A view opens with its first row selected, on the first load and on a
// change of view; Esc clears the selection until a row is opened or the view changes. Under 800px, where the list and
// the centre are two screens, nothing is selected unasked.
import { listRepos } from './index-model';
import { type ListRow, shownGroups } from './list-model';
import { queueId } from './queue-view';
import { selectCard } from './reads';
import { listed, openQueue, type Store } from './store';
import { closeDetail, reopenQueue, selectRun } from './streams';

/** What a row opens: a run, with the call an Inbox row names, or a queue. */
export type Opens = { run: { repo: string; runId: string; key?: string } } | { queue: string };

/** The rows the list shows, those of folded groups left out unless `folded`. */
export function shownRows(store: Store, folded: boolean): ListRow[] {
  const { ui, host } = store;
  return shownGroups(ui.view, listRepos(store.index ?? [], host.now()), ui, host.now(), listed(store))
    .filter((group) => folded || !ui.listFolded.includes(group.id))
    .flatMap((group) => group.rows);
}

/** What a click on `row` opens, or undefined for a row that opens nothing. */
export function opens(row: ListRow): Opens | undefined {
  if (row.kind === 'run') return { run: { repo: row.repo, runId: row.run.runId } };
  if (row.kind === 'queue') return { queue: queueId(row.repo, row.workflow) };
  const { opens: target, workflow } = row.item;
  if (target !== undefined)
    return {
      run: { repo: target.repo, runId: target.runId, ...(target.key === undefined ? {} : { key: target.key }) },
    };
  return workflow === undefined ? undefined : { queue: queueId(row.repo, workflow) };
}

/** Whether the centre shows what `row` opens. */
export function isOpenRow(store: Store, row: ListRow): boolean {
  const { ui } = store;
  const target = opens(row);
  if (target === undefined) return false;
  if ('queue' in target) return ui.queue === target.queue;
  return ui.queue === undefined && ui.repo === target.run.repo && ui.runId === target.run.runId;
}

/** Opens `row` as a click on it does. */
export function openRow(store: Store, row: ListRow): void {
  const { ui } = store;
  const target = opens(row);
  if (target === undefined) return;
  if ('queue' in target) {
    reopenQueue(store, target.queue);
    ui.queue = target.queue;
  } else {
    delete ui.queue;
    selectRun(store, target.run.repo, target.run.runId);
    if (target.run.key !== undefined) selectCard(store, target.run.key, 'overview', false);
  }
  store.deselected = false;
  store.mark('list', 'main', 'inspector', 'status');
}

/** Whether the centre shows a run or a queue. */
const somethingOpen = (store: Store) => store.run !== undefined || openQueue(store) !== undefined;

/**
 * Applies `change` to what the list shows, then selects the first row left when the change dropped the open row from
 * the list, or when nothing is open and a person has not closed it. A run the list never showed stays open.
 */
export function keepSelection(store: Store, change: () => void): void {
  if (store.host.narrow()) {
    change();
    return;
  }
  const was = shownRows(store, true).some((row) => isOpenRow(store, row));
  change();
  const is = shownRows(store, true).some((row) => isOpenRow(store, row));
  if ((was && !is) || (!somethingOpen(store) && !store.deselected)) selectFirst(store);
}

/**
 * Selects the first row of the view that opens something, unless it is open already; with none, closes what is open so
 * the empty state shows. Nothing is selected under 800px.
 */
export function selectFirst(store: Store): void {
  if (store.host.narrow()) return;
  const first = shownRows(store, false).find((row) => opens(row) !== undefined);
  if (first === undefined) {
    if (somethingOpen(store)) closeDetail(store);
    return;
  }
  if (!isOpenRow(store, first)) openRow(store, first);
}
