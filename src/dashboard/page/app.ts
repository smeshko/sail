// The page's shell. `boot(host)` makes the store and wires the modules to the host, and returns the page:
//
// - `store.ts` holds what is on screen, and `saved.ts` what the browser keeps between visits.
// - `draw.ts` draws the regions marked dirty, coalesced into one flush at most every 100 ms, and draws the running
//   times again each second while anything runs.
// - `streams.ts` keeps the index, run and queue sockets, and `reads.ts` reads over REST what the selection shows.
// - `actions.ts` does what a click on a view asks, and `act.ts` carries out the registry's actions (`action-registry.ts`,
//   drawn by `action-view.ts`), the only module that posts; `keys.ts` does what a key asks. Enter and Space on
//   a focused stage card arrive as its action, and on a focused button or link not at all.
//
// The page's URL names the view and the selection (`location.ts`, opened by `navigate.ts`, also on Back and forward),
// and the top bar's Copy link copies it (`actions.ts`).
//
// The rules each module follows are in its own header.
import { createActor } from './act';
import { dispatch } from './actions';
import { startDraw } from './draw';
import type { PageHost } from './host';
import { REGIONS } from './host';
import { onKey } from './keys';
import { syncUrl } from './location';
import { navigate, showView } from './navigate';
import { stopReads } from './reads';
import { saveCleared, storedCleared } from './saved';
import { createStore } from './store';
import { closeRun, openIndex, selectRun, stopStreams } from './streams';
import { toast } from './toast';
import type { UiState } from './ui-state';

export { TICK_MS } from './draw';
export { LOG_REFRESH_MS } from './reads';
export { CLEARED_KEY, FILTER_KEY, LIST_KEY, THEME_KEY } from './saved';
export { FLUSH_MS } from './store';
export { RECENT_EVENTS, RECONNECT_MS } from './streams';

export interface Page {
  stop(): void;
  /** What the page holds, for tests. */
  readonly ui: UiState;
}

export function boot(host: PageHost): Page {
  const store = createStore(host);
  store.actor = createActor({
    host,
    ui: store.ui,
    source: () => ({ run: store.offers, index: store.index ?? [] }),
    openRun: () => (store.run === undefined ? undefined : { repo: store.run.repo, runId: store.run.runId }),
    effects: {
      reopen(repo, runId, keepMenu) {
        const menu = store.ui.runMenu;
        closeRun(store);
        selectRun(store, repo, runId);
        // The menu the action was made from stays open on the run read again, with the answer.
        if (keepMenu && menu !== undefined) store.ui.runMenu = { ...menu };
        syncUrl(store, false);
      },
      open: (repo, runId) => {
        selectRun(store, repo, runId);
        syncUrl(store, false);
      },
      leave: () => closeRun(store),
      took: () => store.fresh.add('main'),
      toast: (kind, head, text, undo) => toast(store, kind, head, text, undo),
      local: {
        'clear-attention': () => {
          const before = new Set([...storedCleared(host), ...store.cleared]);
          const added = new Set(store.drawn.filter((each) => !before.has(each)));
          store.cleared = new Set([...before, ...store.drawn]);
          saveCleared(host, store.cleared);
          store.mark('attention');
          if (added.size === 0) return undefined;
          return {
            text: `${added.size} hidden`,
            // Undo lists the same items again: exactly the identities this click added leave the stored set, and an
            // identity another tab saved since stays.
            undo: () => {
              store.cleared = new Set([...storedCleared(host), ...store.cleared].filter((each) => !added.has(each)));
              saveCleared(host, store.cleared);
              store.mark('attention');
            },
          };
        },
      },
    },
    mark: (...regions) => store.mark(...regions),
    stopped: () => store.stopped,
  });
  startDraw(store);
  host.onAction((action, data) => dispatch(store, action, data));
  host.onKey((key, inInput, on) => onKey(store, key, inInput, on));
  host.onInput((name, value) => {
    if (name === 'list-filter') dispatch(store, 'list-filter', { value });
    if (name === 'list-status') dispatch(store, 'filter-status', { value });
    if (name === 'list-workflow') dispatch(store, 'filter-workflow', { value });
  });
  host.onNavigate((asked) => {
    // Before the first index the entry's view is shown and its query is what the index opens; after it, what the entry
    // names is opened, and the URL is only replaced where what is shown differs from it.
    if (store.start !== undefined) {
      store.start = asked;
      showView(store, asked);
      store.mark('list');
      return;
    }
    navigate(store, asked, true);
    store.url = new URLSearchParams(asked).toString();
    syncUrl(store, false);
  });
  openIndex(store, (asked) => navigate(store, asked, false));
  store.mark(...REGIONS);

  return {
    ui: store.ui,
    stop() {
      store.stopped = true;
      stopStreams(store);
      if (store.flushTimer !== undefined) host.cancel(store.flushTimer);
      stopReads(store);
      for (const timer of store.toastTimers.values()) host.cancel(timer);
      if (store.tickTimer !== undefined) host.cancel(store.tickTimer);
    },
  };
}
