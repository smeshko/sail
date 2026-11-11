// Draws any action of the registry: its parameters and its button, for a subject, from the action state and the
// server's offers. Pure: it returns markup and reads `act`, and has no handler of its own, since the button's
// `data-action` is the action's id and the delegated click carries it out (`act.ts`).
//
// - Not offered, nothing is drawn.
// - An offer that is disabled is drawn disabled, with its `why`, only where the caller asks (`honourDisabled`): the run
//   menu does, the queue view draws its own disabled controls with the reason, and the watch set draws enabled, with
//   the server's refusal coming with the POST.
import type { ActionDef, OfferSource, Param, Subject, Values } from './action-registry';
import { html, type SafeHtml } from './html';
import type { ActState } from './ui-state';

export interface ControlOptions {
  /** Draw a disabled offer disabled, with its `why`. */
  honourDisabled?: boolean;
  /** The button's class: `btn` by default. */
  class?: string;
  /** The button's `title`. */
  title?: string;
  /** Carry the subject's `data-repo`, `data-workflow` and `data-item`. */
  data?: boolean;
  /** More `data-*` the button carries, by name: `{ harness: 'k' }` is `data-harness="k"`. */
  attrs?: Readonly<Record<string, string>>;
  /** Wrap the parameters and the button in a `span.act`. */
  wrap?: boolean;
}

function dataOf(subject: Subject): SafeHtml | '' {
  switch (subject.kind) {
    case 'run':
      return html` data-repo="${subject.repo}" data-run="${subject.runId}"`;
    case 'item':
      return html` data-repo="${subject.repo}" data-workflow="${subject.workflow}" data-item="${subject.item}"`;
    case 'workflow':
      return html` data-repo="${subject.repo}" data-workflow="${subject.workflow}"`;
    case 'repo':
      return html` data-repo="${subject.repo}"`;
    case 'none':
      return '';
  }
}

/** The field that draws `param`, with what was typed; `focus` makes it the one the page focuses when it is drawn. */
export function field(param: Param, values: Values, focus = false): SafeHtml | '' {
  if (param.given !== undefined) return '';
  const typed = values[param.name];
  switch (param.type) {
    case 'number':
      return html`<label class="lbl">${param.label} <input class="num" type="number" name="${param.dom}"${
        param.min === undefined ? '' : html` min="${param.min}"`
      } step="any" value="${typed ?? ''}"${focus ? ' autofocus' : ''}></label>`;
    case 'text':
      return html`<label class="lbl">${param.label} <input class="txt" type="text" name="${param.dom}"${
        param.placeholder === undefined ? '' : html` placeholder="${param.placeholder}"`
      } value="${typed ?? ''}"${focus ? ' autofocus' : ''}></label>`;
    case 'choice': {
      const chosen = param.options.some((each) => each.value === typed) ? typed : param.initial;
      return html`<label class="lbl">${param.label} <select name="${param.dom}"${focus ? ' autofocus' : ''}>${param.options.map(
        (each) =>
          html`<option value="${each.value}"${each.title === undefined ? '' : html` title="${each.title}"`}${each.value === chosen ? ' selected' : ''}>${each.value}</option>`,
      )}</select></label>`;
    }
  }
}

/** The action's parameters and its button, or `''` when the source doesn't offer it. */
export function actionControl(
  def: ActionDef,
  subject: Subject,
  act: ActState,
  source: OfferSource,
  options: ControlOptions = {},
): SafeHtml | '' {
  const available = def.available(subject, source);
  if (!available.offered) return '';
  const wrap = (inner: SafeHtml) => (options.wrap === true ? html`<span class="act">${inner}</span>` : inner);
  if (!available.enabled && options.honourDisabled === true) {
    return wrap(
      html`<button class="btn" disabled>${def.label(subject)}</button><span class="act-why">${available.why}</span>`,
    );
  }
  const values = act.drafts[def.id] ?? {};
  const label = def.label(subject);
  const params = def
    .params(subject, source)
    .filter((param) => param.ask !== 'dialog')
    .map((param) => field(param, values));
  return wrap(
    html`${params}<button class="${options.class ?? 'btn'}" data-action="${def.id}"${
      options.data === true ? dataOf(subject) : ''
    }${Object.entries(options.attrs ?? {}).map(([name, value]) => html` data-${name}="${value}"`)}${options.title === undefined ? '' : html` title="${options.title}"`}>${label}</button>`,
  );
}
