// The confirmation dialog's markup: a title naming the action and its subject, a run by its ticket key or pull request
// with its title and full id on a quiet line under it, a field for each parameter the action asks there (the first
// focused) with the refusal of a value it can't send beside them, one line per consequence, the primary button reading
// the verb, focused first when there is no field, and `cancel`. Pure: `act.ts` opens it with the host.
import type { Param, Values } from './action-registry';
import { field } from './action-view';
import { html, type SafeHtml } from './html';

export interface DialogView {
  title: string;
  lines: string[];
  /** A preformatted text under the lines: a start's roster. */
  text?: string | undefined;
  verb: string;
  /** The run the title names by its short name: its title and full id, on a quiet line under the title. */
  about?: { title?: string | undefined; id: string } | undefined;
}

/** The parameters a dialog asks, what was typed for them and the refusal of what can't be sent. */
export interface DialogAsk {
  fields: readonly Param[];
  values: Values;
  error?: string | undefined;
}

/**
 * `view` with the run `runId` called by its short name, its ticket key or pull request, in its title, and its title and
 * full id kept for the quiet line under it. Its lines keep the id, which a path in them may hold. Unchanged when the run
 * has no short name.
 */
export function namedView(
  view: DialogView,
  runId: string,
  name: { key: string; title?: string | undefined } | undefined,
): DialogView {
  if (name === undefined) return view;
  return { ...view, title: view.title.split(runId).join(name.key), about: { title: name.title, id: runId } };
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
  const { about } = view;
  const sub =
    about === undefined
      ? ''
      : html`<p class="dlg-sub">${about.title === undefined || about.title === '' ? '' : html`<span class="dlg-about">${about.title}</span>`}<span class="dlg-id">${about.id}</span></p>`;
  return html`<h2 id="dialog-title">${view.title}</h2>${sub}${fields}<ul class="dlg-lines">${view.lines.map((line) => html`<li>${line}</li>`)}</ul>${
    view.text === undefined ? '' : html`<pre class="dlg-pre">${view.text}</pre>`
  }`;
}

export function renderDialog(view: DialogView, ask?: DialogAsk): SafeHtml {
  const asked = ask !== undefined && ask.fields.length > 0 ? ask : undefined;
  const body = renderDialogBody(view, ask);
  // A dialog that asks a parameter keeps its body apart, so a change redraws it and leaves the buttons in place.
  return html`${asked === undefined ? body : html`<div id="dialog-body">${body}</div>`}<div class="dlg-acts"><button class="btn primary" data-action="dialog-confirm"${asked === undefined ? ' autofocus' : ''}>${view.verb}</button><button class="btn" data-action="dialog-cancel">cancel</button></div>`;
}
