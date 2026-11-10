import { actions, closeAttention, dispatch, step } from './actions';
import { startDraw } from './draw';
import type { PageHost } from './host';
import { REGIONS } from './host';
import { closeFile, selectCard, stopReads } from './reads';
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

/** The keys that move the card cursor, and by how much. */
const MOVES: Record<string, number> = { j: 1, ArrowDown: 1, ArrowRight: 1, k: -1, ArrowUp: -1, ArrowLeft: -1 };

export function boot(host: PageHost): Page {
  const store = createStore(host);
  const ui = store.ui;

  startDraw(store);

  const keys: Record<string, () => void> = {
    Enter: () => {
      const card = store.run?.model.cards[ui.cursor];
      if (card !== undefined) selectCard(store, card.key, undefined, true);
    },
    // Needs attention and the drawer shut first; then back to the cards from a timeline, keeping the selection; from
    // the cards, no selection.
    Escape: () => {
      if (ui.runMenu !== undefined) {
        delete ui.runMenu;
        delete ui.armed;
        store.mark('rail');
      } else if (ui.itemMenu !== undefined) {
        delete ui.itemMenu;
        delete ui.armedDrop;
        store.mark('main');
      } else if (ui.attention) closeAttention(store);
      else if (ui.file !== undefined) closeFile(store);
      else if (ui.timeline) actions['close-timeline']?.(store, {});
      else selectCard(store, undefined);
    },
    ']': () => step(store, 1),
    '[': () => step(store, -1),
    i: () => actions['toggle-inspector']?.(store, {}),
    a: () => actions['toggle-attention']?.(store, {}),
  };

  host.onAction((action, data) => dispatch(store, action, data));
  host.onKey((key, inInput) => {
    if (inInput) return;
    const by = MOVES[key];
    if (by === undefined) return keys[key]?.();
    const last = (store.run?.model.cards.length ?? 0) - 1;
    ui.cursor = Math.max(0, Math.min(last, ui.cursor + by));
    store.mark('main');
  });
  openIndex(store, (asked) => actions.open?.(store, asked));
  store.mark(...REGIONS);

  return {
    ui,
    stop() {
      store.stopped = true;
      stopStreams(store);
      if (store.flushTimer !== undefined) host.cancel(store.flushTimer);
      stopReads(store);
      if (store.tickTimer !== undefined) host.cancel(store.tickTimer);
    },
  };
}
