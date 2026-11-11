// The toast stack's markup: the newest `TOASTS_SHOWN` toasts under a quiet line counting the rest, one `div.toast`
// each, a refusal `role="alert"` and a success or a hint `role="status"`. A toast reads `<head> — <text>`, with an
// `undo` button for an undoable action's and a ✕ that dismisses it. Pure.
import { html, type SafeHtml } from './html';
import { TOASTS_SHOWN, type Toast } from './toasts';

/** Each kind's class: a hint's is `quiet`, since `.hint` is the inspector's note. */
const CLASS: Record<Toast['kind'], string> = { ok: 'ok', bad: 'bad', hint: 'quiet' };

export function renderToasts(toasts: readonly Toast[]): SafeHtml {
  const shown = toasts.slice(-TOASTS_SHOWN);
  const more = toasts.length - shown.length;
  return html`${more > 0 ? html`<div class="toast-more">+${more} more</div>` : ''}${shown.map(
    (toast) =>
      html`<div class="toast ${CLASS[toast.kind]}" role="${toast.kind === 'bad' ? 'alert' : 'status'}" data-toast="${toast.id}"><span class="toast-msg"><span class="toast-head">${toast.head}</span> — <span class="toast-text">${toast.text}</span></span>${
        toast.undo === true
          ? html`<button class="btn" data-action="undo-toast" data-toast="${toast.id}">${toast.undoLabel ?? 'undo'}</button>`
          : ''
      }<button class="toast-x" data-action="dismiss-toast" data-toast="${toast.id}" aria-label="dismiss" title="dismiss">✕</button></div>`,
  )}`;
}
