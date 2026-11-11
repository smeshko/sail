// What a key does on the page. With a run or queue open, `j`, `k` and the arrows move the card cursor within the cards,
// `Enter` opens the card under it and `]` and `[` step to the next and previous card; with none open, they move the
// list's cursor over its entries (group headers and the rows of the groups not folded), `Enter` opens the row under it
// or folds the group, and `.` opens the menu of the run under it. `Escape` shuts, in order, the run menu, the item menu,
// needs attention, the drawer and the timeline, then the selection and, last, the open run or queue, which gives the
// list the centre. `/` focuses the list's filter field, `1`, `2` and `3` open Active, Queues and History, and `i` and `a`
// toggle the inspector and needs attention. A key typed in an input does nothing but, for Escape, take the focus off.
import { actions, closeAttention, step } from './actions';
import { listRepos } from './index-model';
import { entries, filterRows, groupsOf, type ListRow, VIEWS } from './list-model';
import { closeFile, selectCard } from './reads';
import type { Store } from './store';

/** The keys that move the cursor, and by how much. */
export const MOVES: Record<string, number> = { j: 1, ArrowDown: 1, ArrowRight: 1, k: -1, ArrowUp: -1, ArrowLeft: -1 };

/** What the list shows now: its groups under the repository filter and the filter field. */
function shown(store: Store) {
  const { ui, host } = store;
  return filterRows(groupsOf(ui.view, listRepos(store.index ?? [], host.now()), ui.repoFilter), ui.listFilter);
}

/** The row with `id` in what the list shows. */
const rowOf = (store: Store, id: string | undefined): ListRow | undefined =>
  shown(store)
    .flatMap((group) => group.rows)
    .find((row) => row.id === id);

/** Whether a run or queue is open beside the list, so the keys belong to it. */
const detailOpen = (store: Store) => store.run !== undefined || store.ui.queue !== undefined;

/** Moves the list's cursor `by` entries, clamped, to the first entry when its own is gone. */
function moveList(store: Store, by: number) {
  const { ui } = store;
  const ids = entries(shown(store), ui.listFolded);
  const at = ids.indexOf(ui.listCursor ?? '');
  const next = at < 0 ? ids[0] : ids[Math.max(0, Math.min(ids.length - 1, at + by))];
  // Only a move that changes the cursor asks for a reveal: one left set would scroll a later redraw (review R10).
  if (next === undefined || next === ui.listCursor) return;
  ui.listCursor = next;
  store.revealList = true;
  store.mark('list');
}

/** Opens the row under the list's cursor, or folds the group under it. */
function openCursor(store: Store) {
  const { ui } = store;
  const row = rowOf(store, ui.listCursor);
  if (row === undefined) {
    if (ui.listCursor !== undefined && entries(shown(store), []).includes(ui.listCursor))
      actions['toggle-list-group']?.(store, { group: ui.listCursor });
  } else if (row.kind === 'run') actions['select-run']?.(store, { repo: row.repo, run: row.run.runId });
  else actions['select-queue']?.(store, { queue: `${row.repo}/${row.workflow}` });
}

export const keys: Record<string, (store: Store) => void> = {
  Enter: (store) => {
    if (!detailOpen(store)) return openCursor(store);
    const card = store.run?.model.cards[store.ui.cursor];
    if (card !== undefined) selectCard(store, card.key, undefined, true);
  },
  // The run menu, the item menu, needs attention and the drawer shut first, in that order; then back to the cards
  // from a timeline, keeping the selection; from the cards, no selection; last, the run or queue itself.
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
  '.': (store) => {
    const row = rowOf(store, store.ui.listCursor);
    if (row?.kind === 'run') actions['run-menu']?.(store, { repo: row.repo, run: row.run.runId });
  },
  '/': (store) => store.host.focus('list-filter'),
  1: (store) => actions['select-view']?.(store, { view: VIEWS[0] ?? 'active' }),
  2: (store) => actions['select-view']?.(store, { view: VIEWS[1] ?? 'queues' }),
  3: (store) => actions['select-view']?.(store, { view: VIEWS[2] ?? 'history' }),
};

/**
 * Handles `key`: in an input, Escape takes the focus off and nothing else is handled; else a cursor move, clamped to the
 * cards or, with none open, to the list's entries, else the key's function. Answers true for `/`, whose default would
 * type it into the field just focused.
 */
export function onKey(store: Store, key: string, inInput: boolean): boolean {
  if (inInput) {
    if (key === 'Escape') store.host.blur();
    return false;
  }
  const by = MOVES[key];
  if (by === undefined) {
    keys[key]?.(store);
    return key === '/';
  }
  if (!detailOpen(store)) {
    moveList(store, by);
    return false;
  }
  const last = (store.run?.model.cards.length ?? 0) - 1;
  store.ui.cursor = Math.max(0, Math.min(last, store.ui.cursor + by));
  store.mark('main');
  return false;
}
