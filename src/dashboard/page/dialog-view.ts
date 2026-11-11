// The confirmation dialog's markup: a title naming the action and its subject, one line per consequence, the primary
// button reading the verb, focused first, and `cancel`. Pure: `act.ts` opens it with the host.
import { html, type SafeHtml } from './html';

export interface DialogView {
  title: string;
  lines: string[];
  verb: string;
}

export function renderDialog(view: DialogView): SafeHtml {
  return html`<h2 id="dialog-title">${view.title}</h2><ul class="dlg-lines">${view.lines.map((line) => html`<li>${line}</li>`)}</ul><div class="dlg-acts"><button class="btn primary" data-action="dialog-confirm" autofocus>${view.verb}</button><button class="btn" data-action="dialog-cancel">cancel</button></div>`;
}
