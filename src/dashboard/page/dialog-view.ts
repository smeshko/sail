// The confirmation dialog's markup: a title naming the action and its subject, a field for each parameter the action
// asks there (the first focused) with the refusal of a value it can't send beside them, one line per consequence, the
// primary button reading the verb, focused first when there is no field, and `cancel`. Pure: `act.ts` opens it with the
// host.
import type { Param, Values } from './action-registry';
import { field } from './action-view';
import { html, type SafeHtml } from './html';

export interface DialogView {
  title: string;
  lines: string[];
  /** A preformatted text under the lines: a start's roster. */
  text?: string | undefined;
  verb: string;
}

/** The parameters a dialog asks, what was typed for them and the refusal of what can't be sent. */
export interface DialogAsk {
  fields: readonly Param[];
  values: Values;
  error?: string | undefined;
}

/** What a dialog that asks a parameter draws again at a change: its title, fields and lines, never its buttons. */
export function renderDialogBody(view: DialogView, ask?: DialogAsk): SafeHtml {
  const asked = ask !== undefined && ask.fields.length > 0 ? ask : undefined;
  const fields =
    asked === undefined
      ? ''
      : html`<div class="dlg-fields">${asked.fields.map((param, at) => field(param, asked.values, at === 0))}${
          asked.error === undefined ? '' : html`<span class="dlg-bad" role="alert">${asked.error}</span>`
        }</div>`;
  return html`<h2 id="dialog-title">${view.title}</h2>${fields}<ul class="dlg-lines">${view.lines.map((line) => html`<li>${line}</li>`)}</ul>${
    view.text === undefined ? '' : html`<pre class="dlg-pre">${view.text}</pre>`
  }`;
}

export function renderDialog(view: DialogView, ask?: DialogAsk): SafeHtml {
  const asked = ask !== undefined && ask.fields.length > 0 ? ask : undefined;
  const body = renderDialogBody(view, ask);
  // A dialog that asks a parameter keeps its body apart, so a change redraws it and leaves the buttons in place.
  return html`${asked === undefined ? body : html`<div id="dialog-body">${body}</div>`}<div class="dlg-acts"><button class="btn primary" data-action="dialog-confirm"${asked === undefined ? ' autofocus' : ''}>${view.verb}</button><button class="btn" data-action="dialog-cancel">cancel</button></div>`;
}
