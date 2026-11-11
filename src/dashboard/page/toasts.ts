// The dashboard's toasts as data: what is on the stack and how one joins or leaves it. Pure: the shell
// (`toast.ts`) owns the timers, and `toast-view.ts` draws the list.

/** A success leaves after this long. */
export const TOAST_MS = 4000;
/** A toast carrying Undo leaves after this long. */
export const UNDO_MS = 8000;
/** A key's hint leaves after this long. */
export const HINT_MS = 3000;
/** How many toasts the stack shows: the newest, under a line counting the rest. */
export const TOASTS_SHOWN = 3;

export interface Toast {
  id: number;
  /** A success, a refusal, or a hint: what a key that can't be done here needs, which asked the server nothing. */
  kind: 'ok' | 'bad' | 'hint';
  /** `<verb> <subject>`, such as `clean ADW-1-…`, or a key's `<verb> (<key>)`. */
  head: string;
  /** Sail's own words. */
  text: string;
  /** Whether it carries a button: Undo, or the one `undoLabel` names. */
  undo?: boolean;
  /** What its button says in place of undo: a refusal's start anyway. */
  undoLabel?: string;
}

/**
 * `list` with `toast` added at its end. A refusal equal in head and text to one still shown replaces it, and a hint
 * replaces the hint shown, so one is shown at a time.
 */
export function addToast(list: readonly Toast[], toast: Toast): Toast[] {
  const replaces = (each: Toast) =>
    toast.kind === 'hint'
      ? each.kind === 'hint'
      : toast.kind === 'bad' && each.kind === 'bad' && each.head === toast.head && each.text === toast.text;
  return [...list.filter((each) => !replaces(each)), toast];
}

/** `list` without the toast `id`. */
export function removeToast(list: readonly Toast[], id: number): Toast[] {
  return list.filter((each) => each.id !== id);
}
