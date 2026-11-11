// The page's URL, kept in step with what it shows. `toQuery()` is the query string of a `UiState`: a queue open in the
// centre is `queue=<repo>/<workflow>` alone, else a run is `repo`, `run`, then, with a call selected, `key`, `tab`
// unless it is `overview`, `timeline=1` while the centre shows the call's timeline, and `file` while the drawer holds a
// file. `syncUrl()` is the one place the shell writes the URL: a person's selections (a click, a key) push a history
// entry, and what a stream or an answer changes replaces the current one.
import type { Store } from './store';
import type { UiState } from './ui-state';

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
  return query.toString();
}

/**
 * Writes the URL to what the page shows, once the first index has opened what the page was loaded with: nothing before
 * it, so a click cannot wipe the link the page came from. A query equal to the one last written writes nothing.
 */
export function syncUrl(store: Store, push: boolean): void {
  if (store.start !== undefined) return;
  const query = toQuery(store.ui);
  if (query === store.url) return;
  store.url = query;
  store.host.setUrl(query, push);
}
