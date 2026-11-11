// Opens what a query names, at the page's first index and on the browser's Back and forward. A listed queue opens in the
// centre; a listed run opens with its call, tab, timeline and file, each only when it differs from what is open. A run
// or queue the index does not list sets `ui.indexNotice` and, as `fallback` says, opens the newest run (`first`, at
// load) or keeps what is shown (`keep`, on Back and forward). An empty query opens the newest run at load, with no
// notice. It never writes the URL: the caller does, once it has opened what it can.

import { queuePanels } from './index-model';
import { fromQuery, syncUrl } from './location';
import { queueId } from './queue-view';
import { closeFile, openFile, readLog, selectCard } from './reads';
import type { Store } from './store';
import { firstRun, reopenQueue, selectRun } from './streams';

/** Opens the newest run, as the first index does with nothing named. */
function openFirst(store: Store) {
  const first = firstRun(store, store.index ?? []);
  if (first !== undefined) selectRun(store, first.repo, first.runId);
}

/** Closes the file a read found missing, and says so. */
function missing(store: Store, path: string, runId: string) {
  closeFile(store);
  store.ui.indexNotice = `file ${path} is not in run ${runId}`;
  store.mark('rail');
  syncUrl(store, false);
}

export function navigate(store: Store, asked: Record<string, string>, fallback: 'first' | 'keep'): void {
  const { ui } = store;
  const target = fromQuery(asked);
  const repos = store.index ?? [];
  if (target.queue !== undefined) {
    const id = target.queue;
    if (queuePanels(repos).some((panel) => queueId(panel.repo, panel.workflow) === id)) {
      reopenQueue(store, id);
      ui.queue = id;
      store.actor.clearResult('queue');
      if (store.run === undefined && fallback === 'first') openFirst(store);
    } else {
      if (fallback === 'first') openFirst(store);
      ui.indexNotice = `queue ${id} is not listed`;
    }
  } else if (target.repo !== undefined && target.run !== undefined) {
    const { repo, run } = target;
    if (repos.some((each) => each.name === repo && each.runs.some((entry) => entry.runId === run))) {
      delete ui.queue;
      selectRun(store, repo, run);
      if (target.key === undefined) {
        if (ui.key !== undefined) selectCard(store, undefined);
      } else if (target.key !== ui.key) selectCard(store, target.key, target.tab, target.timeline);
      else if (target.tab !== ui.tab || target.timeline !== ui.timeline) {
        ui.tab = target.tab;
        ui.timeline = target.timeline;
        if (ui.tab === 'log') readLog(store);
      }
      if (target.file === undefined) closeFile(store);
      else if (ui.file?.path !== target.file)
        openFile(store, target.file.split('/').at(-1) ?? target.file, target.file, () =>
          missing(store, target.file ?? '', run),
        );
    } else {
      if (fallback === 'first') openFirst(store);
      ui.indexNotice = `run ${run} of ${repo} is not listed`;
    }
  } else if (fallback === 'first') openFirst(store);
  store.mark('rail', 'main', 'inspector');
}
