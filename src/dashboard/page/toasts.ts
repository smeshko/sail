// The dashboard's toasts as data: what is on the stack and how one joins or leaves it. Pure: the shell
// (`toast.ts`) owns the timers, and `toast-view.ts` draws the list.

/** A success leaves after this long. */
export const TOAST_MS = 4000;
/** A toast carrying Undo leaves after this long. */
export const UNDO_MS = 8000;

export interface Toast {
  id: number;
  kind: 'ok' | 'bad';
  /** `<verb> <subject>`, such as `clean ADW-1-…`. */
  head: string;
  /** Sail's own words. */
  text: string;
  /** Whether it carries a button: Undo, or the one `undoLabel` names. */
  undo?: boolean;
  /** What its button says in place of undo: a refusal's start anyway. */
  undoLabel?: string;
}

/** `list` with `toast` added at its end. A refusal equal in head and text to one still shown replaces it. */
export function addToast(list: readonly Toast[], toast: Toast): Toast[] {
  const kept =
    toast.kind === 'bad'
      ? list.filter((each) => !(each.kind === 'bad' && each.head === toast.head && each.text === toast.text))
      : list;
  return [...kept, toast];
}

/** `list` without the toast `id`. */
export function removeToast(list: readonly Toast[], id: number): Toast[] {
  return list.filter((each) => each.id !== id);
}
