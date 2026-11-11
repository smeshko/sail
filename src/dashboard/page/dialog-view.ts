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
  verb: string;
}

/** The parameters a dialog asks, what was typed for them and the refusal of what can't be sent. */
export interface DialogAsk {
  fields: readonly Param[];
  values: Values;
  error?: string | undefined;
}

export function renderDialog(view: DialogView, ask?: DialogAsk): SafeHtml {
  const asked = ask !== undefined && ask.fields.length > 0 ? ask : undefined;
  const fields =
    asked === undefined
      ? ''
      : html`<div class="dlg-fields">${asked.fields.map((param, at) => field(param, asked.values, at === 0))}${
          asked.error === undefined ? '' : html`<span class="dlg-bad" role="alert">${asked.error}</span>`
        }</div>`;
  return html`<h2 id="dialog-title">${view.title}</h2>${fields}<ul class="dlg-lines">${view.lines.map((line) => html`<li>${line}</li>`)}</ul><div class="dlg-acts"><button class="btn primary" data-action="dialog-confirm"${asked === undefined ? ' autofocus' : ''}>${view.verb}</button><button class="btn" data-action="dialog-cancel">cancel</button></div>`;
}
