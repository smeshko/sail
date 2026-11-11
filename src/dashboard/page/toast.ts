// The shell's toasts: `toast()` puts one on the stack and, for a success, has it leave after `TOAST_MS` (`UNDO_MS` with
// an Undo), `dismissToast()` takes one off, and `undoToast()` runs its Undo and takes it off. A refusal stays until it is
// dismissed. The timers run on the host's clock, so a test advances them. `toasts` is marked dirty only when the stack
// changes, never by the one-second tick, so a live region is not announced again.

import type { Store } from './store';
import { addToast, removeToast, TOAST_MS, UNDO_MS } from './toasts';

/** Puts a toast on the stack. `undo`, when given, is what its Undo button does. */
export function toast(store: Store, kind: 'ok' | 'bad', head: string, text: string, undo?: () => void): void {
  const { ui, host } = store;
  const id = ++store.toastSeq;
  const before = ui.toasts;
  ui.toasts = addToast(before, { id, kind, head, text, ...(undo === undefined ? {} : { undo: true }) });
  // A refusal that replaced an equal one leaves that one's Undo and timer behind: drop whatever of a removed toast stayed.
  for (const old of before) if (!ui.toasts.some((each) => each.id === old.id)) forget(store, old.id);
  if (undo !== undefined) store.undos.set(id, undo);
  if (kind === 'ok') {
    store.toastTimers.set(
      id,
      host.later(() => dismissToast(store, id), undo === undefined ? TOAST_MS : UNDO_MS),
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

export function undoToast(store: Store, id: number): void {
  const undo = store.undos.get(id);
  dismissToast(store, id);
  undo?.();
}
