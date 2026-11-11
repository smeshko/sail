// Opens what a query names, at the page's first index and on the browser's Back and forward. A listed queue opens in the
// centre; a listed run opens with its call, tab, timeline and file, each only when it differs from what is open. A run
// or queue the index does not list is said in a toast and keeps what is shown: at load, no run, which leaves the list
// the centre. On Back and forward (`moved`), a query that names neither closes the open run or queue, with no notice,
// and the list shows the view the query names, `active` when it names none; at load the store has read the view
// already, and a click made before the first index keeps its view. The caller writes the URL once it has opened what
// it can, but for a file the run turns out not to have: `missing()` replaces the URL itself, when the file's read
// answers.

import { queuePanels } from './index-model';
import { fromQuery, syncUrl } from './location';
import { queueId } from './queue-view';
import { closeFile, openFile, readLog, selectCard } from './reads';
import type { Store } from './store';
import { closeDetail, reopenQueue, selectRun } from './streams';
import { sayMissing } from './toast';

/** Closes the file a read found missing, and says so. */
function missing(store: Store, path: string, runId: string) {
  closeFile(store);
  sayMissing(store, `file ${path} is not in run ${runId}`);
  syncUrl(store, false);
}

/** Shows the list view a Back or forward entry names, `active` when it names none. */
export function showView(store: Store, asked: Record<string, string>): void {
  const { ui } = store;
  const view = fromQuery(asked).view ?? 'active';
  if (view === ui.view) return;
  ui.view = view;
  ui.listFilter = '';
  delete ui.listCursor;
  store.fresh.add('list');
}

export function navigate(store: Store, asked: Record<string, string>, moved: boolean): void {
  const { ui } = store;
  const target = fromQuery(asked);
  const repos = store.index ?? [];
  if (moved) showView(store, asked);
  if (target.queue !== undefined) {
    const id = target.queue;
    if (queuePanels(repos).some((panel) => queueId(panel.repo, panel.workflow) === id)) {
      reopenQueue(store, id);
      ui.queue = id;
    } else sayMissing(store, `queue ${id} is not listed`);
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
    } else sayMissing(store, `run ${run} of ${repo} is not listed`);
  } else if (moved) closeDetail(store);
  store.mark('sidebar', 'list', 'main', 'inspector');
}
