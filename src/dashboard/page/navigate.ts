// Opens what a query names, at the page's first index and on the browser's Back and forward. A listed queue opens in the
// centre; a listed run opens with its call, tab, timeline and file, each only when it differs from what is open. A run
// or queue the index does not list is said in a toast and keeps what is shown: at load, no run, which leaves the list
// the centre. On Back and forward (`moved`), a query that names neither closes the open run or queue, with no notice,
// and the list shows the view and filters the query names, `active` and none when it names none; at load the store has
// read them already, and a click made before the first index keeps its view. A repository or workflow filter the index
// does not list is dropped, and the caller's URL write replaces the query, with no toast. The caller writes the URL once it has opened what
// it can, but for a file the run turns out not to have: `missing()` replaces the URL itself, when the file's read
// answers.

import { listRepos, queuePanels } from './index-model';
import { historyWorkflows } from './list-model';
import { fromQuery, syncUrl } from './location';
import { queueId } from './queue-view';
import { closeFile, openFile, readLog, selectCard } from './reads';
import { selectFirst } from './selection';
import type { Store } from './store';
import { closeDetail, reopenQueue, selectRun } from './streams';
import { sayMissing } from './toast';

/** Closes the file a read found missing, and says so. */
function missing(store: Store, path: string, runId: string) {
  closeFile(store);
  sayMissing(store, `file ${path} is not in run ${runId}`);
  syncUrl(store, false);
}

/** Shows the list view and filters a load or a Back or forward entry names, none for what it leaves out. */
export function showView(store: Store, asked: Record<string, string>): void {
  const { ui } = store;
  const target = fromQuery(asked);
  const view = target.view ?? 'active';
  const was = [ui.view, ui.repoFilter, ui.listFilter, ui.historyStatus, ui.historyWorkflow];
  ui.view = view;
  if (target.repoFilter === undefined) delete ui.repoFilter;
  else ui.repoFilter = target.repoFilter;
  ui.listFilter = target.listFilter ?? '';
  if (target.historyStatus === undefined) delete ui.historyStatus;
  else ui.historyStatus = target.historyStatus;
  if (target.historyWorkflow === undefined) delete ui.historyWorkflow;
  else ui.historyWorkflow = target.historyWorkflow;
  const now = [ui.view, ui.repoFilter, ui.listFilter, ui.historyStatus, ui.historyWorkflow];
  if (now.every((value, at) => value === was[at])) return;
  if (view !== was[0]) {
    store.deselected = false;
    delete ui.listCursor;
  }
  store.fresh.add('list');
  store.revealOpen = true;
  store.mark('sidebar', 'list');
}

export function navigate(store: Store, asked: Record<string, string>, moved: boolean): void {
  const { ui } = store;
  const target = fromQuery(asked);
  const repos = store.index ?? [];
  if (moved) showView(store, asked);
  // A repository or workflow a URL named that the index does not list is dropped, and the caller replaces the URL.
  if (ui.repoFilter !== undefined && !repos.some((each) => each.name === ui.repoFilter)) {
    delete ui.repoFilter;
    store.fresh.add('list');
  }
  if (
    ui.historyWorkflow !== undefined &&
    !historyWorkflows(listRepos(repos, store.host.now()), ui.repoFilter).includes(ui.historyWorkflow)
  ) {
    delete ui.historyWorkflow;
    store.fresh.add('list');
  }
  if (target.queue !== undefined) {
    const id = target.queue;
    if (queuePanels(repos).some((panel) => queueId(panel.repo, panel.workflow) === id)) {
      reopenQueue(store, id);
      ui.queue = id;
      store.deselected = false;
      store.revealOpen = true;
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
  } else if (moved) {
    closeDetail(store);
    store.deselected = true;
  } else selectFirst(store);
  store.mark('sidebar', 'list', 'main', 'inspector');
}
