// What a key does on the page: `j`, `k` and the arrows move the card cursor within the cards, `Enter` opens the card
// under it, `Escape` shuts, in order, the run menu, the item menu, needs attention, the drawer and the timeline, then the
// selection and, last, the open run or queue, which gives the list the centre, `]` and `[` step to the next and previous card, and `i` and `a` toggle the inspector and needs attention. A
// key typed in an input does nothing.
import { actions, closeAttention, step } from './actions';
import { closeFile, selectCard } from './reads';
import type { Store } from './store';

/** The keys that move the card cursor, and by how much. */
export const MOVES: Record<string, number> = { j: 1, ArrowDown: 1, ArrowRight: 1, k: -1, ArrowUp: -1, ArrowLeft: -1 };

export const keys: Record<string, (store: Store) => void> = {
  Enter: (store) => {
    const card = store.run?.model.cards[store.ui.cursor];
    if (card !== undefined) selectCard(store, card.key, undefined, true);
  },
  // The run menu, the item menu, needs attention and the drawer shut first, in that order; then back to the cards
  // from a timeline, keeping the selection; from the cards, no selection.
  Escape: (store) => {
    const { ui } = store;
    if (ui.runMenu !== undefined) {
      delete ui.runMenu;
      delete ui.armed;
      store.mark('list');
    } else if (ui.itemMenu !== undefined) {
      delete ui.itemMenu;
      delete ui.armedDrop;
      store.mark('main');
    } else if (ui.attention) closeAttention(store);
    else if (ui.file !== undefined) closeFile(store);
    else if (ui.timeline) actions['close-timeline']?.(store, {});
    else if (ui.key !== undefined) selectCard(store, undefined);
    else actions['close-detail']?.(store, {});
  },
  ']': (store) => step(store, 1),
  '[': (store) => step(store, -1),
  i: (store) => actions['toggle-inspector']?.(store, {}),
  a: (store) => actions['toggle-attention']?.(store, {}),
};

/** Handles `key`: nothing in an input, a cursor move clamped to the cards, else the key's function. */
export function onKey(store: Store, key: string, inInput: boolean): void {
  if (inInput) return;
  const by = MOVES[key];
  if (by === undefined) {
    keys[key]?.(store);
    return;
  }
  const last = (store.run?.model.cards.length ?? 0) - 1;
  store.ui.cursor = Math.max(0, Math.min(last, store.ui.cursor + by));
  store.mark('main');
}
