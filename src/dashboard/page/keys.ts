// What a key does on the page. With a run or queue open, `j`, `k` and the arrows move the card cursor within the cards,
// `Enter` opens the card under it and `]` and `[` step to the next and previous card; with none open, they move the
// list's cursor over its entries (group headers and the rows of the groups not folded), `Enter` opens the row under it
// or folds the group, `.` opens the menu of the run under it, and `x`, in History, marks or unmarks the run under it.
// Cmd+K or Ctrl+K opens the command menu, or closes it, and any other Cmd or Ctrl chord does nothing. While the command
// menu is open its keys alone are handled (`menu.ts`): the arrows move its highlight, `Enter` runs its row, and
// `Escape` goes back one step, then closes it. Otherwise `Escape` shuts, in order, the folded sidebar, the run menu, the
// item menu, the drawer and the timeline, then the card selection, then, with no run or queue open, the History
// selection and, last, the open run or queue, which gives the list the centre. `/` focuses the list's filter field, `1`
// to `4` open Inbox, Active, Queues and History, `a` opens the Inbox and `i` pins the inspector open or unpins it. In
// the Inbox `e` dismisses the row under the cursor, else the open run's row, and Shift+E all clear. A key typed in an
// input does nothing but, for Escape, take the focus off.
import { actions, dispatch, shutSidebar, step } from './actions';
import { setFocus } from './focus';
import { listRepos } from './index-model';
import { type AttentionRow, attentionSubject, entries, type ListRow, shownGroups, VIEWS } from './list-model';
import { syncUrl } from './location';
import { menuKey, toggleMenu } from './menu';
import { closeFile, selectCard } from './reads';
import { listed, type Store } from './store';

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
  // The row under the cursor is the cursor's subject: a run, or a queue's workflow. A group header is none.
  const row = rowOf(store, next);
  setFocus(
    ui,
    'cursor',
    row === undefined
      ? undefined
      : row.kind === 'run'
        ? { kind: 'run', repo: row.repo, runId: row.run.runId }
        : row.kind === 'attention'
          ? attentionSubject(row)
          : { kind: 'workflow', repo: row.repo, workflow: row.workflow },
  );
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
    if (!detailOpen(store)) return openCursor(store);
    const card = store.run?.model.cards[store.ui.cursor];
    if (card !== undefined) selectCard(store, card.key, undefined, true);
  },
  // The folded sidebar, the run menu, the item menu and the drawer shut first, in that order; then back to the cards
  // from a timeline, keeping the selection; from the cards, no selection; last, the run or queue itself.
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
  // Marks the History run row under the list's cursor, with no run or queue open.
  x: (store) => {
    const { ui } = store;
    const row = detailOpen(store) || ui.view !== 'history' ? undefined : rowOf(store, ui.listCursor);
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
 * handled; else a cursor move, clamped to the cards or, with none open, to the list's entries, else the key's function.
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
  if (store.ui.menu !== undefined) return menuKey(store, key);
  if (inInput) {
    if (key === 'Escape') store.host.blur();
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
  if (!detailOpen(store)) {
    moveList(store, by);
    return false;
  }
  const last = (store.run?.model.cards.length ?? 0) - 1;
  store.ui.cursor = Math.max(0, Math.min(last, store.ui.cursor + by));
  store.mark('main');
  return false;
}
