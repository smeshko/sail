// The command menu's shell: it opens on the focused subject, filters as the field is typed in, moves its highlight over
// the enabled rows, and runs the highlighted row: "go to" opens what it names and makes it the cursor's subject, and
// the view actions change what is shown. `menu-model.ts` makes the rows and `menu-view.ts` the markup; this module holds
// only what the person did. The subject is frozen at the open: the hover is dropped while the menu is open.
//
// - A row's place is `ui.menu.at`, the one a person moved to. A row that is missing or disabled once the offers arrive
//   is skipped for the first enabled row (`highlighted()`), so a read that lands late can't leave the highlight on it.
// - Enter on a row that is disabled does nothing.

import type { Subject } from './action-registry';
import { actions } from './actions';
import { focused, setFocus, syncOpen } from './focus';
import { type MenuModel, menuRows } from './menu-model';
import { queueId } from './queue-view';
import { readSubjectOffers } from './reads';
import { type Store, sourceFor } from './store';
import type { MenuState } from './ui-state';

/** What the open menu draws now, from its state, the offers and the index. */
export function modelOf(store: Store, menu: MenuState): MenuModel {
  return menuRows(menu, sourceFor(store, menu.subject), store.index ?? [], store.host.now());
}

/** The row the highlight is on: the one asked for when it is there and enabled, else the first enabled one, else -1. */
export function highlighted(model: MenuModel, at: number): number {
  const asked = model.rows[at];
  if (asked !== undefined && !asked.disabled) return at;
  return model.rows.findIndex((row) => !row.disabled);
}

/** Opens the menu on `subject` (the focused one when none is given). A context menu is the subject's group alone, at `point`. */
export function openMenu(
  store: Store,
  mode: MenuState['mode'],
  subject?: Subject,
  point?: { x: number; y: number },
): void {
  const { ui } = store;
  syncOpen(store);
  const chosen = subject ?? (mode === 'full' ? focused(ui) : undefined);
  ui.menu = {
    mode,
    query: '',
    at: 0,
    steps: [],
    ...(chosen === undefined ? {} : { subject: chosen }),
    ...(point === undefined ? {} : { point }),
  };
  if (chosen !== undefined) readSubjectOffers(store, chosen);
  store.menuFocus = true;
  store.fresh.add('menu');
  store.mark('menu');
}

export function closeMenu(store: Store): void {
  if (store.ui.menu === undefined) return;
  delete store.ui.menu;
  store.menuFocus = false;
  store.mark('menu');
}

export function toggleMenu(store: Store): void {
  if (store.ui.menu === undefined) openMenu(store, 'full');
  else closeMenu(store);
}

/** What was typed in the menu's field: it filters, and the highlight goes back to the first row. */
export function menuInput(store: Store, value: string): void {
  const { menu } = store.ui;
  if (menu === undefined) return;
  menu.query = value;
  menu.at = 0;
  delete menu.error;
  store.mark('menu');
}

/** Moves the highlight `by` enabled rows, wrapping round the ends. */
function move(store: Store, menu: MenuState, by: 1 | -1): void {
  const model = modelOf(store, menu);
  const enabled = model.rows.flatMap((row, place) => (row.disabled ? [] : [place]));
  if (enabled.length === 0) return;
  const at = enabled.indexOf(highlighted(model, menu.at));
  menu.at = enabled[(Math.max(at, 0) + by + enabled.length) % enabled.length] ?? 0;
  store.mark('menu');
}

/** Goes to the object a "go to" row names: opens a run or a queue, or unfolds a repository, and puts the cursor on it. */
function goTo(store: Store, subject: Subject): void {
  const { ui } = store;
  switch (subject.kind) {
    case 'run':
      actions.open?.(store, { repo: subject.repo, run: subject.runId });
      break;
    case 'workflow':
    case 'item':
      actions['select-queue']?.(store, { queue: queueId(subject.repo, subject.workflow) });
      break;
    case 'repo':
      actions['select-view']?.(store, { view: 'queues' });
      if (ui.listFolded.includes(`queues:${subject.repo}`))
        actions['toggle-list-group']?.(store, { group: `queues:${subject.repo}` });
      break;
    case 'none':
      return;
  }
  setFocus(ui, 'cursor', subject);
}

/** Runs the `n`-th row of the menu. A disabled row, or one that isn't there, does nothing. */
export function runRow(store: Store, n: number): void {
  const { menu } = store.ui;
  if (menu === undefined) return;
  const row = modelOf(store, menu).rows[n];
  if (row === undefined || row.disabled) return;
  const { run } = row;
  if ('goto' in run) {
    closeMenu(store);
    goTo(store, run.goto);
  } else if ('view' in run) {
    closeMenu(store);
    actions[run.view]?.(store, {});
  }
}

/** Handles a key while the menu is open. Answers true for a key it took. */
export function menuKey(store: Store, key: string): boolean {
  const { menu } = store.ui;
  if (menu === undefined) return false;
  if (key === 'ArrowDown' || key === 'ArrowUp') move(store, menu, key === 'ArrowDown' ? 1 : -1);
  else if (key === 'Enter') runRow(store, highlighted(modelOf(store, menu), menu.at));
  else if (key === 'Escape') closeMenu(store);
  else return false;
  return true;
}
