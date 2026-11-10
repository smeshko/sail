// The page's shell. `boot(host)` makes the store and wires the modules to the host, and returns the page:
//
// - `store.ts` holds what is on screen, and `saved.ts` what the browser keeps between visits.
// - `draw.ts` draws the regions marked dirty, coalesced into one flush at most every 100 ms, and draws the running
//   times again each second while anything runs.
// - `streams.ts` keeps the index, run and queue sockets, and `reads.ts` reads over REST what the selection shows.
// - `actions.ts` does what a click asks, its POSTs in `requests.ts`; `keys.ts` does what a key asks. Enter and Space on
//   a focused stage card arrive as its action, and on a focused button or link not at all.
//
// The rules each module follows are in its own header.
import { actions, dispatch } from './actions';
import { startDraw } from './draw';
import type { PageHost } from './host';
import { REGIONS } from './host';
import { onKey } from './keys';
import { stopReads } from './reads';
import { createStore } from './store';
import { openIndex, stopStreams } from './streams';
import type { UiState } from './ui-state';

export { TICK_MS } from './draw';
export { LOG_REFRESH_MS } from './reads';
export { CLEARED_KEY, FILTER_KEY, RAIL_KEY, THEME_KEY } from './saved';
export { FLUSH_MS } from './store';
export { RECENT_EVENTS, RECONNECT_MS } from './streams';

export interface Page {
  stop(): void;
  /** What the page holds, for tests. */
  readonly ui: UiState;
}

export function boot(host: PageHost): Page {
  const store = createStore(host);
  startDraw(store);
  host.onAction((action, data) => dispatch(store, action, data));
  host.onKey((key, inInput) => onKey(store, key, inInput));
  openIndex(store, (asked) => actions.open?.(store, asked));
  store.mark(...REGIONS);

  return {
    ui: store.ui,
    stop() {
      store.stopped = true;
      stopStreams(store);
      if (store.flushTimer !== undefined) host.cancel(store.flushTimer);
      stopReads(store);
      if (store.tickTimer !== undefined) host.cancel(store.tickTimer);
    },
  };
}
