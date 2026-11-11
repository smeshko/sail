// The command menu's shell: it opens on the focused subject, filters as the field is typed in, moves its highlight over
// the enabled rows, and runs the highlighted row: "go to" opens what it names and makes it the cursor's subject, and
// the view actions change what is shown. `menu-model.ts` makes the rows and `menu-view.ts` the markup; this module holds
// only what the person did. The subject is frozen at the open: the hover is dropped while the menu is open.
//
// - A row's place is `ui.menu.at`, and the row a person moved to is `ui.menu.row`, by its identity, so the highlight
//   follows that row when an index tick adds or removes rows before it. A row that is missing or disabled once the
//   offers arrive is skipped for the first enabled row (`highlighted()`), so a read that lands late can't leave the
//   highlight on it.
// - Enter on a row that is disabled does nothing.
// - An action whose parameters its click doesn't give asks them as steps, one for each, in the menu: a choice
//   lists its options, a number or a text is typed in the field. After the last, the registry's `request()` decides:
//   `invalid` shows its words and keeps the step, nothing to send keeps it too, else the menu closes and the actor is
//   handed the action with the values asked, which opens the confirmation dialog for a confirmed one. Escape goes back
//   one step, then lets go of the subject, then closes the menu.

import { actionOf, type Subject } from './action-registry';
import { actions } from './actions';
import { focused, setFocus, syncOpen } from './focus';
import { askedParams, type MenuModel, type MenuRow, menuRows, subjectData } from './menu-model';
import { queueId } from './queue-view';
import { readSubjectOffers } from './reads';
import { type Store, sourceFor } from './store';
import type { MenuState, MenuStep } from './ui-state';

/** What the open menu draws now, from its state, the offers and the index. */
export function modelOf(store: Store, menu: MenuState): MenuModel {
  return menuRows(menu, sourceFor(store, menu.subject), store.index ?? [], store.host.now());
}

/** A row's identity: its group, its label and what it runs, whatever its place. */
export function rowKey(row: MenuRow): string {
  return JSON.stringify([row.group, row.label, 'act' in row.run ? row.run.act : row.run]);
}

/**
 * The row the highlight is on: the row a person moved to (`row`) wherever it now is, else the place asked for, when it
 * is there and enabled; else the first enabled one, else -1.
 */
export function highlighted(model: MenuModel, at: number, row?: string): number {
  const place = row === undefined ? at : model.rows.findIndex((each) => rowKey(each) === row);
  const asked = model.rows[place];
  if (asked !== undefined && !asked.disabled) return place;
  return model.rows.findIndex((each) => !each.disabled);
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
  delete menu.row;
  delete menu.error;
  store.mark('menu');
}

/** Moves the highlight `by` enabled rows, wrapping round the ends. */
function move(store: Store, menu: MenuState, by: 1 | -1): void {
  const model = modelOf(store, menu);
  const enabled = model.rows.flatMap((row, place) => (row.disabled ? [] : [place]));
  if (enabled.length === 0) return;
  const at = enabled.indexOf(highlighted(model, menu.at, menu.row));
  menu.at = enabled[(Math.max(at, 0) + by + enabled.length) % enabled.length] ?? 0;
  const row = model.rows[menu.at];
  if (row !== undefined) menu.row = rowKey(row);
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

/** Shows a step: the field empties, the menu takes the focus, and the highlight starts on `start`. */
function enter(store: Store, menu: MenuState, start = 0): void {
  menu.query = '';
  menu.at = start;
  delete menu.row;
  delete menu.error;
  store.fresh.add('menu');
  store.menuFocus = true;
  store.mark('menu');
}

/** The step `action` asks first for `subject`, or undefined when its click gives everything. */
function firstStep(store: Store, action: string, subject: Subject, data: Record<string, string>): MenuStep | undefined {
  const def = actionOf(action);
  if (def === undefined || askedParams(def, subject, sourceFor(store, subject)).length === 0) return undefined;
  return { action, subject, data, values: {}, at: 0 };
}

/** Hands the action to the actor, with what was asked, and closes the menu. */
function carryOut(store: Store, action: string, data: Record<string, string>, values?: Record<string, string>): void {
  closeMenu(store);
  store.actor.act(action, data, values);
}

/** Pushes `step` and shows it, starting the highlight on the option its model starts on. */
function push(store: Store, menu: MenuState, step: MenuStep): void {
  menu.steps.push(step);
  enter(store, menu, modelOf(store, menu).step?.start ?? 0);
}

/** Takes `value` for the parameter the open step asks: the next step, or the action itself after the last. */
function answer(store: Store, menu: MenuState, step: Extract<MenuStep, { action: string; at: number }>, value: string) {
  const def = actionOf(step.action);
  if (def === undefined) return;
  const source = sourceFor(store, step.subject);
  const asked = askedParams(def, step.subject, source);
  const name = asked[step.at]?.name;
  if (name === undefined) return;
  const values = { ...step.values, [name]: value };
  if (step.at + 1 < asked.length) {
    push(store, menu, { ...step, values, at: step.at + 1 });
    return;
  }
  // After the last parameter the registry decides: words it refuses with stay in the menu, and so does nothing to send.
  const request = def.request?.(step.subject, values, source);
  if (request === undefined) return;
  if ('invalid' in request) {
    menu.error = request.invalid;
    store.mark('menu');
    return;
  }
  carryOut(store, step.action, step.data, values);
}

/** Polls every queue that offers a poll and has it enabled, one request each. */
function pollAll(store: Store): void {
  const source = sourceFor(store);
  const poll = actionOf('poll-queue');
  closeMenu(store);
  for (const repo of source.index) {
    for (const queue of repo.queues) {
      const subject: Subject = { kind: 'workflow', repo: repo.name, workflow: queue.workflow };
      const available = poll?.available(subject, source);
      if (available?.offered === true && available.enabled)
        store.actor.act('poll-queue', { repo: repo.name, workflow: queue.workflow });
    }
  }
}

/** The step open, if it is one that asks a parameter. */
const openStep = (menu: MenuState) => {
  const step = menu.steps.at(-1);
  return step !== undefined && 'at' in step ? step : undefined;
};

function runStepRow(store: Store, menu: MenuState, row: MenuRow): void {
  const { run } = row;
  const step = openStep(menu);
  if ('value' in run && step !== undefined) answer(store, menu, step, run.value);
  else if ('queue' in run) {
    const last = menu.steps.at(-1);
    const subject: Subject = { kind: 'workflow', repo: run.queue.repo, workflow: run.queue.workflow };
    const action = last !== undefined && 'pick' in last ? last.action : '';
    const first = firstStep(store, action, subject, subjectData(subject));
    if (first === undefined) carryOut(store, action, subjectData(subject));
    else push(store, menu, first);
  }
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
  } else if ('act' in run) {
    const first = firstStep(store, run.act, run.subject, run.data);
    if (first === undefined) carryOut(store, run.act, run.data);
    else push(store, menu, first);
  } else if ('pollAll' in run) pollAll(store);
  else if ('pick' in run) push(store, menu, { pick: 'queue', action: run.pick });
  else runStepRow(store, menu, row);
}

/**
 * Escape: back one step; with none open, the full menu lets go of its subject, so its chip and the subject's actions
 * go and what was typed stays; with no subject, or in a context menu, it closes.
 */
function back(store: Store, menu: MenuState): void {
  if (menu.steps.length > 0) {
    menu.steps.pop();
    enter(store, menu, modelOf(store, menu).step?.start ?? 0);
    return;
  }
  if (menu.mode === 'full' && menu.subject !== undefined && menu.subject.kind !== 'none') {
    delete menu.subject;
    menu.at = 0;
    delete menu.row;
    delete menu.error;
    store.mark('menu');
    return;
  }
  closeMenu(store);
}

/** Handles a key while the menu is open. Answers true for a key it took. */
export function menuKey(store: Store, key: string): boolean {
  const { menu } = store.ui;
  if (menu === undefined) return false;
  if (key === 'ArrowDown' || key === 'ArrowUp') move(store, menu, key === 'ArrowDown' ? 1 : -1);
  else if (key === 'Enter') {
    const model = modelOf(store, menu);
    const step = openStep(menu);
    // A typed step takes what is in the field, from the page's own, else what was typed.
    if (step !== undefined && model.step?.field !== undefined)
      answer(store, menu, step, store.host.value('menu-query') ?? menu.query);
    else runRow(store, highlighted(model, menu.at, menu.row));
  } else if (key === 'Escape') back(store, menu);
  else return false;
  return true;
}
