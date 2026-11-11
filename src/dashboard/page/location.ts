// The page's URL, kept in step with what it shows. `toQuery()` is the query string of a `UiState`: a queue open in the
// centre is `queue=<repo>/<workflow>`, else a run is `repo`, `run`, then, with a call selected, `key`, `tab` unless it
// is `overview`, `timeline=1` while the centre shows the call's timeline, and `file` while the drawer holds a file.
// Then `view`, the list's view, unless it is `active`, and the list's filters: `in`, the sidebar's repository, `q`, the
// text typed in the filter field, and in History alone `status` and `workflow`; an empty filter writes no parameter,
// and `repo` stays the open run's repository. `syncUrl()` is the one place the shell writes the URL: a
// person's selections (a click, a key, a chosen repository, status or workflow) push a history entry, and what a stream,
// an answer or typing in the list's filter field changes replaces the current one.
import { VIEWS, type ViewName } from './list-model';
import type { Store } from './store';
import { type InspectorTab, TABS, type UiState } from './ui-state';

/** The query string of what `ui` shows, without its `?`: empty when it shows nothing. */
export function toQuery(ui: UiState): string {
  const query = new URLSearchParams();
  if (ui.queue !== undefined) query.set('queue', ui.queue);
  else if (ui.repo !== undefined && ui.runId !== undefined) {
    query.set('repo', ui.repo);
    query.set('run', ui.runId);
    if (ui.key !== undefined) {
      query.set('key', ui.key);
      if (ui.tab !== 'overview') query.set('tab', ui.tab);
      if (ui.timeline) query.set('timeline', '1');
    }
    if (ui.file !== undefined) query.set('file', ui.file.path);
  }
  if (ui.view !== 'active') query.set('view', ui.view);
  if (ui.repoFilter !== undefined) query.set('in', ui.repoFilter);
  if (ui.listFilter !== '') query.set('q', ui.listFilter);
  if (ui.view === 'history') {
    if (ui.historyStatus !== undefined) query.set('status', ui.historyStatus);
    if (ui.historyWorkflow !== undefined) query.set('workflow', ui.historyWorkflow);
  }
  return query.toString();
}

/**
 * Writes the URL to what the page shows, once the first index has opened what the page was loaded with: nothing before
 * it, so a click cannot wipe the link the page came from. A query equal to the one last written writes nothing, and a
 * write the browser refused is not remembered, so the next sync tries it again.
 */
export function syncUrl(store: Store, push: boolean): void {
  if (store.start !== undefined) return;
  const query = toQuery(store.ui);
  if (query === store.url) return;
  if (store.host.setUrl(query, push)) store.url = query;
}

/** What a query asks the page to show. */
export interface Target {
  queue?: string;
  repo?: string;
  run?: string;
  key?: string;
  tab: InspectorTab;
  timeline: boolean;
  file?: string;
  /** The list's view, when the query names a known one. */
  view?: ViewName;
  /** The list's filters, each present only when the query names it. */
  repoFilter?: string;
  listFilter?: string;
  historyStatus?: 'failed' | 'completed';
  historyWorkflow?: string;
}

/** The target a query names: a queue alone, else a run with its call, tab, timeline and file. */
export function fromQuery(asked: Record<string, string>): Target {
  const known = (VIEWS as readonly string[]).includes(asked.view ?? '');
  const history = known && asked.view === 'history';
  const asking = asked.status;
  const status = asking === 'failed' || asking === 'completed' ? asking : undefined;
  const view: Pick<Target, 'view' | 'repoFilter' | 'listFilter' | 'historyStatus' | 'historyWorkflow'> = {
    ...(known ? { view: asked.view as ViewName } : {}),
    ...(asked.in ? { repoFilter: asked.in } : {}),
    ...(asked.q ? { listFilter: asked.q } : {}),
    ...(history && status !== undefined ? { historyStatus: status } : {}),
    ...(history && asked.workflow ? { historyWorkflow: asked.workflow } : {}),
  };
  if (asked.queue !== undefined) return { queue: asked.queue, tab: 'overview', timeline: false, ...view };
  const tab = (TABS as readonly string[]).includes(asked.tab ?? '') ? (asked.tab as InspectorTab) : 'overview';
  return {
    ...(asked.repo === undefined ? {} : { repo: asked.repo }),
    ...(asked.run === undefined ? {} : { run: asked.run }),
    ...(asked.key === undefined ? {} : { key: asked.key }),
    tab,
    timeline: asked.timeline === '1',
    ...(asked.file === undefined ? {} : { file: asked.file }),
    ...view,
  };
}
