// What a key does on the page. Every key is declared once, in `keymap.ts`: the navigation keys in its table, by id, with
// what each does here (`does`), and the actions' keys in the registry, done to the focused subject (`key-act.ts`). The
// shortcut sheet `?` opens lists the same table and keys.
//
// `j`, `k`, the arrows and `Enter` drive one pane, the keyed pane: in the centre they move the card cursor within the
// open run's cards and `Enter` opens the card under it; in the list they move the list's cursor over its entries (group
// headers and the rows of the groups not folded), and `Enter` opens the row under it, which gives the centre the keys,
// or folds the group. From 800px up, with a run or queue open beside the list, `w` gives the keys to the other pane,
// each cursor keeping its place, and a click in a pane, or one that opens a row, gives them to that pane (`app.ts`,
// `actions.ts`); a change of view gives them to the list, with its first row open. Under 800px, or with nothing open,
// the keys drive what shows: the open run or queue, else the list. `]` and `[` step to the next and previous card, `.`
// opens the menu of the run under the list's cursor, and `x`, in History with the keys in the list, marks or unmarks
// the run under it.
// Cmd+K or Ctrl+K opens the command menu, or closes it, Cmd+. copies the focused subject's id, and any other Cmd or Ctrl
// chord does nothing. While the command menu is open its keys alone are handled (`menu.ts`): the arrows move its
// highlight, `Enter` runs its row, and `Escape` goes back one step, then lets go of its subject, then closes it; a key
// that changes what is shown writes the URL, as a click does. While the shortcut sheet is open, `Escape` and `?` close
// it and no other key does anything. Otherwise `Escape` shuts, in order, the folded sidebar, the run menu, the item
// menu, the drawer and the timeline, then the card selection, then, with no run or queue open, the History selection
// and, last, the open run or queue, which leaves the centre's empty state and no row selected. `/` focuses the list's
// filter field, `1` to `4` and `g` then `i`, `a`, `q` or `h` open Inbox, Active, Queues and History, `a` opens the Inbox
// too and `i` pins the inspector open or unpins it. `o` opens the open run's pull request, else its ticket, `l` and
// `f` its call's log and files, and `z` undoes what the newest toast with an Undo did. A key typed in an input does
// nothing but, for Escape, take the focus off.

import { subjectName } from './action-registry';
import { actions, shutSidebar, step } from './actions';
import { moveList, openCursor, rowOf, switchPane } from './cursor';
import { safeHref } from './html';
import { actOnKey, keySubject } from './key-act';
import { LEADS, type NavId, navOf } from './keymap';
import { VIEWS } from './list-model';
import { syncUrl } from './location';
import { menuKey, toggleMenu } from './menu';
import { closeFile, selectCard } from './reads';
import { centreRun, detailOpen, drivenPane, type Store, summaryOf } from './store';
import { toast, undoToast } from './toast';

export { inboxRow } from './cursor';

/** Moves the cursor of the pane the keys drive `by` places, clamped to its cards or entries. */
function move(store: Store, by: number) {
  if (drivenPane(store) === 'list') return moveList(store, by);
  const last = (store.run?.model.cards.length ?? 0) - 1;
  store.ui.cursor = Math.max(0, Math.min(last, store.ui.cursor + by));
  store.mark('main');
}

/** Opens or closes the shortcut sheet, in the menu's place. */
function toggleSheet(store: Store) {
  const { ui } = store;
  ui.sheet = !ui.sheet;
  store.menuFocus = ui.sheet;
  store.mark('menu');
}

/** Selects the call under the card cursor, or the selected one, on the inspector tab `tab`. */
function callTab(store: Store, tab: 'log' | 'files') {
  const run = centreRun(store);
  const card = run?.model.cards.find((each) => each.key === store.ui.key) ?? run?.model.cards[store.ui.cursor];
  if (card === undefined) return toast(store, 'bad', tab, `${tab} needs an open run with a call`);
  selectCard(store, card.key, tab);
}

/** The open run's pull request, else its ticket, in a new tab. */
function openLink(store: Store) {
  const run = centreRun(store);
  if (run === undefined) return toast(store, 'bad', 'open', 'open needs an open run');
  const summary = summaryOf(store, run);
  const result = summary?.result as { pr?: { url?: unknown } } | undefined;
  const url = [run.model.pr?.url, result?.pr?.url, run.model.ticket?.url, summary?.ticket?.url]
    .map((each) => (typeof each === 'string' ? safeHref(each) : undefined))
    .find((each) => each !== undefined);
  if (url === undefined) toast(store, 'bad', `open ${run.runId}`, 'it has no pull request or ticket link');
  else store.host.openLink(url);
}

/** Copies the focused subject's id: a run's id, a queue item's key, a queue's `<repo> / <workflow>`. */
function copyId(store: Store) {
  const subject = keySubject(store);
  if (subject === undefined || subject.kind === 'none')
    return toast(store, 'bad', 'copy', 'nothing is focused to copy');
  actions.copy?.(store, { text: subjectName(subject) });
}

/** What each navigation key of `keymap.ts` does. */
export const does: Record<NavId, (store: Store) => void> = {
  menu: (store) => toggleMenu(store),
  filter: (store) => store.host.focus('list-filter'),
  sheet: toggleSheet,
  inbox: (store) => actions['select-view']?.(store, { view: VIEWS[0] }),
  active: (store) => actions['select-view']?.(store, { view: VIEWS[1] }),
  queues: (store) => actions['select-view']?.(store, { view: VIEWS[2] }),
  history: (store) => actions['select-view']?.(store, { view: VIEWS[3] }),
  pane: switchPane,
  inspector: (store) => actions['toggle-inspector']?.(store, {}),
  // The folded sidebar, the run menu, the item menu and the drawer shut first, in that order; then back to the cards
  // from a timeline, keeping the selection; from the cards, no selection; last, the run or queue itself, which leaves
  // the empty state in the centre.
  back: (store) => {
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
  down: (store) => move(store, 1),
  up: (store) => move(store, -1),
  open: (store) => {
    if (drivenPane(store) === 'list') return openCursor(store);
    const card = store.run?.model.cards[store.ui.cursor];
    if (card !== undefined) selectCard(store, card.key, undefined, true);
  },
  // Marks the History run row under the list's cursor, with the keys in the list.
  select: (store) => {
    const { ui } = store;
    const row = drivenPane(store) !== 'list' || ui.view !== 'history' ? undefined : rowOf(store, ui.listCursor);
    if (row?.kind === 'run') actions['toggle-select']?.(store, { row: row.id });
  },
  'row-menu': (store) => {
    const row = rowOf(store, store.ui.listCursor);
    if (row?.kind === 'run') actions['run-menu']?.(store, { repo: row.repo, run: row.run.runId });
  },
  copy: copyId,
  link: openLink,
  log: (store) => callTab(store, 'log'),
  files: (store) => callTab(store, 'files'),
  previous: (store) => step(store, -1),
  next: (store) => step(store, 1),
  undo: (store) => {
    const newest = [...store.ui.toasts].reverse().find((each) => each.undo === true && each.undoLabel === undefined);
    if (newest === undefined) toast(store, 'bad', 'undo', 'no toast has an undo');
    else undoToast(store, newest.id);
  },
};

/** Does the navigation key `key`, when the table has it: true when it did. */
function navKey(store: Store, key: string): boolean {
  const entry = navOf(key);
  if (entry === undefined) return false;
  // A key that does something shuts the folded sidebar, as a click does; Escape's own rule shuts it first, and `w`,
  // which does nothing while the sidebar can be open, leaves it.
  if (key !== 'Escape' && entry.id !== 'pane') shutSidebar(store);
  does[entry.id as NavId](store);
  return true;
}

/**
 * Handles `key`: while the dialog is open its keys alone; in an input, Escape takes the focus off and nothing else is
 * handled; else the second key of a sequence, a navigation key, or an action's key. Answers true for a key whose default
 * is to be suppressed: `/`, whose default would type it into the field just focused, a key the command menu took, and
 * an action's key, such as Backspace.
 */
export function onKey(store: Store, key: string, inInput: boolean, on?: string, mod = false): boolean {
  const { ui } = store;
  // While the dialog is open, Escape cancels it, Enter confirms it unless the cancel button holds the focus, and no
  // other key does anything.
  if (store.actor.dialogFor() !== undefined) {
    if (key === 'Escape') store.actor.cancel();
    else if (key === 'Enter' && on !== 'dialog-cancel') store.actor.confirm();
    return false;
  }
  // Cmd or Ctrl with K opens the command menu, or closes it, from anywhere; with `.` it copies the focused subject's
  // id while no field, menu or sheet has the keys; with any other key nothing is done, since typing it would reach a
  // field or the browser's own shortcut.
  if (mod) {
    const chord = `Mod+${key.toLowerCase()}`;
    if (chord === 'Mod+k') {
      ui.sheet = false;
      does.menu(store);
      return true;
    }
    if (chord !== 'Mod+.' || inInput || ui.menu !== undefined || ui.sheet) return false;
    return navKey(store, chord);
  }
  // While the menu is open its keys alone are handled, in its field too.
  if (ui.menu !== undefined) {
    const handled = menuKey(store, key);
    syncUrl(store, true);
    return handled;
  }
  if (ui.sheet) {
    if (key === 'Escape' || key === '?') toggleSheet(store);
    return false;
  }
  if (inInput) {
    if (key === 'Escape') store.host.blur();
    return false;
  }
  // The second key of a sequence: one the table has is done, and any other is a key of its own.
  const lead = ui.chord;
  delete ui.chord;
  if (lead !== undefined && navKey(store, `${lead} ${key}`)) {
    syncUrl(store, true);
    return false;
  }
  if (LEADS.has(key)) {
    ui.chord = key;
    return false;
  }
  if (navKey(store, key)) {
    syncUrl(store, true);
    return key === '/';
  }
  if (!actOnKey(store, key)) return false;
  shutSidebar(store);
  syncUrl(store, true);
  return true;
}
