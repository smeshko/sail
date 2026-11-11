// The toast stack's markup: one `div.toast` per toast, a success `role="status"` and a refusal `role="alert"`, each with
// a `dismiss` button and, for an undoable action's, an `undo` one. Pure.
import { html, type SafeHtml } from './html';
import type { Toast } from './toasts';

export function renderToasts(toasts: readonly Toast[]): SafeHtml {
  return html`${toasts.map(
    (toast) =>
      html`<div class="toast ${toast.kind}" role="${toast.kind === 'bad' ? 'alert' : 'status'}" data-toast="${toast.id}"><span class="toast-head">${toast.head}</span> <span class="toast-text">${toast.text}</span>${
        toast.undo === true
          ? html` <button class="btn" data-action="undo-toast" data-toast="${toast.id}">undo</button>`
          : ''
      } <button class="btn" data-action="dismiss-toast" data-toast="${toast.id}" aria-label="dismiss">dismiss</button></div>`,
  )}`;
}
