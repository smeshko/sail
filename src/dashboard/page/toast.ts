// The shell's toasts: `toast()` puts one on the stack and, for a success, has it leave after `TOAST_MS` (`UNDO_MS` with
// an Undo), and a key's hint after `HINT_MS`, `dismissToast()` takes one off, `dismissNewest()` the newest, and
// `undoToast()` runs its Undo and takes it off. A refusal stays until it is dismissed. The timers run on the host's clock, so a test advances them. `toasts` is marked dirty only when the stack
// changes, never by the one-second tick, so a live region is not announced again.

import type { Store } from './store';
import { addToast, HINT_MS, removeToast, TOAST_MS, type Toast, UNDO_MS } from './toasts';

/** Puts a toast on the stack. `undo`, when given, is what its button does: Undo, or `label`. */
export function toast(
  store: Store,
  kind: Toast['kind'],
  head: string,
  text: string,
  undo?: () => void,
  label?: string,
): void {
  const { ui, host } = store;
  const id = ++store.toastSeq;
  const before = ui.toasts;
  ui.toasts = addToast(before, {
    id,
    kind,
    head,
    text,
    ...(undo === undefined ? {} : { undo: true }),
    ...(label === undefined ? {} : { undoLabel: label }),
  });
  // A refusal that replaced an equal one leaves that one's Undo and timer behind: drop whatever of a removed toast stayed.
  for (const old of before) if (!ui.toasts.some((each) => each.id === old.id)) forget(store, old.id);
  if (undo !== undefined) store.undos.set(id, undo);
  if (kind !== 'bad') {
    const ms = kind === 'hint' ? HINT_MS : undo === undefined ? TOAST_MS : UNDO_MS;
    store.toastTimers.set(
      id,
      host.later(() => dismissToast(store, id), ms),
    );
  }
  store.mark('toasts');
}

function forget(store: Store, id: number): void {
  const timer = store.toastTimers.get(id);
  if (timer !== undefined) store.host.cancel(timer);
  store.toastTimers.delete(id);
  store.undos.delete(id);
}

export function dismissToast(store: Store, id: number): void {
  forget(store, id);
  const { ui } = store;
  if (!ui.toasts.some((each) => each.id === id)) return;
  ui.toasts = removeToast(ui.toasts, id);
  store.mark('toasts');
}

/** Takes the newest toast off the stack: false when there is none. */
export function dismissNewest(store: Store): boolean {
  const newest = store.ui.toasts.at(-1);
  if (newest === undefined) return false;
  dismissToast(store, newest.id);
  return true;
}

/** Says in a toast what a URL named that is not there (a run, queue, call or file), in place of the last such toast. */
export function sayMissing(store: Store, text: string): void {
  endMissing(store);
  toast(store, 'bad', 'open link', text);
  store.missingToast = store.toastSeq;
}

/** Ends the toast that says a URL named what is not there: opening a run or a queue, by any path, does. */
export function endMissing(store: Store): void {
  if (store.missingToast === undefined) return;
  const id = store.missingToast;
  store.missingToast = undefined;
  dismissToast(store, id);
}

export function undoToast(store: Store, id: number): void {
  const undo = store.undos.get(id);
  dismissToast(store, id);
  undo?.();
}
