// What a key does on the page. `j`, `k`, the arrows and `Enter` drive one pane, the keyed pane: in the centre they move
// the card cursor within the open run's cards and `Enter` opens the card under it; in the list they move the list's
// cursor over its entries (group headers and the rows of the groups not folded), and `Enter` opens the row under it,
// which gives the centre the keys, or folds the group. From 800px up, with a run or queue open beside the list, `w`
// gives the keys to the other pane, each cursor keeping its place, and a click in a pane, or one that opens a row, gives
// them to that pane (`app.ts`, `actions.ts`); a change of view gives them to the list, with its first row open. Under
// 800px, or with nothing open, the keys drive what shows: the open run or queue, else the list. `]` and `[` step to the
// next and previous card, `.` opens the menu of the run under the list's cursor, and `x`, in History with the keys in
// the list, marks or unmarks the run under it.
// Cmd+K or Ctrl+K opens the command menu, or closes it, and any other Cmd or Ctrl chord does nothing. While the command
// menu is open its keys alone are handled (`menu.ts`): the arrows move its highlight, `Enter` runs its row, and
// `Escape` goes back one step, then lets go of its subject, then closes it; a key that changes what is shown writes the URL, as a click does. Otherwise `Escape` shuts, in order, the folded sidebar, the run menu, the
// item menu, the drawer and the timeline, then the card selection, then, with no run or queue open, the History
// selection and, last, the open run or queue, which leaves the centre's empty state and no row selected. `/` focuses the list's filter field, `1`
// to `4` open Inbox, Active, Queues and History, `a` opens the Inbox and `i` pins the inspector open or unpins it. In
// the Inbox `e` dismisses the row under the cursor, else the open run's row, and Shift+E all clear. A key typed in an
// input does nothing but, for Escape, take the focus off.

import type { Subject } from './action-registry';
import { actions, dispatch, shutSidebar, step } from './actions';
import { openSubject, setFocus } from './focus';
import { listRepos } from './index-model';
import { type AttentionRow, attentionSubject, entries, type ListRow, shownGroups, VIEWS } from './list-model';
import { syncUrl } from './location';
import { menuKey, toggleMenu } from './menu';
import { closeFile, selectCard } from './reads';
import { opens } from './selection';
import { detailOpen, drivenPane, keyedPane, listed, type Store } from './store';

/** The keys that move the cursor, and by how much. */
export const MOVES: Record<string, number> = { j: 1, ArrowDown: 1, ArrowRight: 1, k: -1, ArrowUp: -1, ArrowLeft: -1 };

/** What the list shows now: its groups under the repository filter and the filter field. */
function shown(store: Store) {
  const { ui, host } = store;
  return shownGroups(ui.view, listRepos(store.index ?? [], host.now()), ui, host.now(), listed(store));
}

/** The row with `id` in what the list shows. */
const rowOf = (store: Store, id: string | undefined): ListRow | undefined =>
  shown(store)
    .flatMap((group) => group.rows)
    .find((row) => row.id === id);

/** The subject of a list row: a run, or a queue's workflow. A group header is none. */
const rowSubject = (row: ListRow | undefined): Subject | undefined =>
  row === undefined
    ? undefined
    : row.kind === 'run'
      ? { kind: 'run', repo: row.repo, runId: row.run.runId }
      : row.kind === 'attention'
        ? attentionSubject(row)
        : { kind: 'workflow', repo: row.repo, workflow: row.workflow };

/** Moves the list's cursor `by` entries, clamped, to the first entry when its own is gone. */
function moveList(store: Store, by: number) {
  const { ui } = store;
  const ids = entries(shown(store), ui.listFolded);
  const at = ids.indexOf(ui.listCursor ?? '');
  const next = at < 0 ? ids[0] : ids[Math.max(0, Math.min(ids.length - 1, at + by))];
  // Only a move that changes the cursor asks for a reveal: one left set would scroll a later redraw (review R10).
  if (next === undefined || next === ui.listCursor) return;
  ui.listCursor = next;
  // The row under the cursor is the cursor's subject.
  setFocus(ui, 'cursor', rowSubject(rowOf(store, next)));
  store.revealList = true;
  store.mark('list');
}

/**
 * `w`: gives the keys to the other pane while both show. The cursor's subject follows them: the row under the list's
 * cursor, or the open run or queue.
 */
function switchPane(store: Store) {
  const pane = keyedPane(store);
  if (pane === undefined) return;
  const { ui } = store;
  ui.pane = pane === 'list' ? 'centre' : 'list';
  setFocus(ui, 'cursor', undefined);
  setFocus(ui, 'cursor', ui.pane === 'list' ? rowSubject(rowOf(store, ui.listCursor)) : openSubject(store));
  store.mark();
}

/** Opens the row under the list's cursor, which gives the centre the keys, or folds the group under it. */
function openCursor(store: Store) {
  const { ui } = store;
  const row = rowOf(store, ui.listCursor);
  // The centre takes the keys even when the row was open already, which draws nothing else.
  if (row !== undefined && opens(row) !== undefined && ui.pane !== 'centre') {
    ui.pane = 'centre';
    store.mark();
  }
  if (row === undefined) {
    if (ui.listCursor !== undefined && entries(shown(store), []).includes(ui.listCursor))
      actions['toggle-list-group']?.(store, { group: ui.listCursor });
  } else if (row.kind === 'attention') {
    const { opens, workflow } = row.item;
    if (opens !== undefined)
      actions.open?.(store, {
        repo: opens.repo,
        run: opens.runId,
        ...(opens.key === undefined ? {} : { key: opens.key }),
      });
    else if (workflow !== undefined) actions['select-queue']?.(store, { queue: `${row.repo}/${workflow}` });
  } else if (row.kind === 'run') actions['select-run']?.(store, { repo: row.repo, run: row.run.runId });
  else actions['select-queue']?.(store, { queue: `${row.repo}/${row.workflow}` });
}

/** The Inbox row `e` dismisses: the one under the list's cursor, else the open run's. */
export function inboxRow(store: Store): AttentionRow | undefined {
  const row = rowOf(store, store.ui.listCursor);
  if (row?.kind === 'attention') return row;
  const open = store.run === undefined || store.ui.queue !== undefined ? undefined : store.run;
  if (open === undefined) return undefined;
  return shown(store)
    .flatMap((group) => group.rows)
    .find(
      (each): each is AttentionRow =>
        each.kind === 'attention' && each.item.opens?.repo === open.repo && each.item.opens.runId === open.runId,
    );
}

export const keys: Record<string, (store: Store) => void> = {
  Enter: (store) => {
    if (drivenPane(store) === 'list') return openCursor(store);
    const card = store.run?.model.cards[store.ui.cursor];
    if (card !== undefined) selectCard(store, card.key, undefined, true);
  },
  // The folded sidebar, the run menu, the item menu and the drawer shut first, in that order; then back to the cards
  // from a timeline, keeping the selection; from the cards, no selection; last, the run or queue itself, which leaves
  // the empty state in the centre.
  Escape: (store) => {
    const { ui } = store;
    if (ui.sidebar) shutSidebar(store);
    else if (ui.runMenu !== undefined) {
      delete ui.runMenu;
      store.mark('list', 'main');
    } else if (ui.itemMenu !== undefined) {
      delete ui.itemMenu;
      store.mark('main');
    } else if (ui.file !== undefined) closeFile(store);
    else if (ui.timeline) actions['close-timeline']?.(store, {});
    else if (ui.key !== undefined) selectCard(store, undefined);
    else if (!detailOpen(store) && ui.listSelected.length > 0) actions['clear-selection']?.(store, {});
    else actions['close-detail']?.(store, {});
  },
  ']': (store) => step(store, 1),
  '[': (store) => step(store, -1),
  i: (store) => actions['toggle-inspector']?.(store, {}),
  e: (store) => {
    if (store.ui.view !== 'inbox') return;
    const target = inboxRow(store);
    if (target !== undefined) dispatch(store, 'dismiss-attention', { item: target.id.slice('inbox:'.length) });
  },
  E: (store) => {
    if (store.ui.view === 'inbox') dispatch(store, 'clear-attention', {});
  },
  a: (store) => actions['select-view']?.(store, { view: 'inbox' }),
  '.': (store) => {
    const row = rowOf(store, store.ui.listCursor);
    if (row?.kind === 'run') actions['run-menu']?.(store, { repo: row.repo, run: row.run.runId });
  },
  // Marks the History run row under the list's cursor, with the keys in the list.
  x: (store) => {
    const { ui } = store;
    const row = drivenPane(store) !== 'list' || ui.view !== 'history' ? undefined : rowOf(store, ui.listCursor);
    if (row?.kind === 'run') actions['toggle-select']?.(store, { row: row.id });
  },
  '/': (store) => store.host.focus('list-filter'),
  1: (store) => actions['select-view']?.(store, { view: VIEWS[0] }),
  2: (store) => actions['select-view']?.(store, { view: VIEWS[1] }),
  3: (store) => actions['select-view']?.(store, { view: VIEWS[2] }),
  4: (store) => actions['select-view']?.(store, { view: VIEWS[3] }),
};

/**
 * Handles `key`: while the dialog is open its keys alone; in an input, Escape takes the focus off and nothing else is
 * handled; else a cursor move in the pane the keys drive, clamped to its cards or entries, else the key's function.
 * Answers true for `/`, whose default would type it into the field just focused, and for a key the command menu took.
 */
export function onKey(store: Store, key: string, inInput: boolean, on?: string, mod = false): boolean {
  // While the dialog is open, Escape cancels it, Enter confirms it unless the cancel button holds the focus, and no
  // other key does anything.
  if (store.actor.dialogFor() !== undefined) {
    if (key === 'Escape') store.actor.cancel();
    else if (key === 'Enter' && on !== 'dialog-cancel') store.actor.confirm();
    return false;
  }
  // Cmd or Ctrl with K opens the command menu, or closes it; with any other key nothing is done, since typing it would
  // reach a field or the browser's own shortcut.
  if (mod) {
    if (key === 'k' || key === 'K') {
      toggleMenu(store);
      return true;
    }
    return false;
  }
  // While the menu is open its keys alone are handled, in its field too.
  if (store.ui.menu !== undefined) {
    const handled = menuKey(store, key);
    syncUrl(store, true);
    return handled;
  }
  if (inInput) {
    if (key === 'Escape') store.host.blur();
    return false;
  }
  if (key === 'w') {
    switchPane(store);
    return false;
  }
  const by = MOVES[key];
  // A key that does something shuts the folded sidebar, as a click does; Escape's own rule shuts it first.
  if (key !== 'Escape' && (by !== undefined || keys[key] !== undefined)) shutSidebar(store);
  if (by === undefined) {
    keys[key]?.(store);
    syncUrl(store, true);
    return key === '/';
  }
  if (drivenPane(store) === 'list') {
    moveList(store, by);
    return false;
  }
  const last = (store.run?.model.cards.length ?? 0) - 1;
  store.ui.cursor = Math.max(0, Math.min(last, store.ui.cursor + by));
  store.mark('main');
  return false;
}
