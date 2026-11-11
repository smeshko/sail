// Draws any action of the registry: its parameters and its button, for a subject, from the action state and the
// server's offers. Pure: it returns markup and reads `act`, and has no handler of its own, since the button's
// `data-action` is the action's id and the delegated click carries it out (`act.ts`).
//
// - Not offered, nothing is drawn.
// - An offer that is disabled is drawn disabled, with its `why`, only where the caller asks (`honourDisabled`): the run
//   menu does, and the queue and the watch set draw enabled, with the server's refusal coming with the POST.
// - While the pending action is this one on this subject and unsent, the button is `armed` and reads its confirm label.
import {
  type ActionDef,
  type OfferSource,
  type Param,
  type Subject,
  sameSubject,
  type Values,
} from './action-registry';
import { html, type SafeHtml } from './html';
import type { ActPlace, ActState } from './ui-state';

export interface ControlOptions {
  /** Draw a disabled offer disabled, with its `why`. */
  honourDisabled?: boolean;
  /** The button's class: `btn` by default. */
  class?: string;
  /** The button's `title`. */
  title?: string;
  /** Carry the subject's `data-repo`, `data-workflow` and `data-item`. */
  data?: boolean;
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

function field(param: Param, values: Values): SafeHtml | '' {
  if (param.given !== undefined) return '';
  const typed = values[param.name];
  switch (param.type) {
    case 'number':
      return html`<label class="lbl">${param.label} <input class="num" type="number" name="${param.dom}"${
        param.min === undefined ? '' : html` min="${param.min}"`
      } step="any" value="${typed ?? ''}"></label>`;
    case 'text':
      return html`<label class="lbl">${param.label} <input class="txt" type="text" name="${param.dom}"${
        param.placeholder === undefined ? '' : html` placeholder="${param.placeholder}"`
      } value="${typed ?? ''}"></label>`;
    case 'choice': {
      if (param.tick === true) {
        return html`<label class="lbl"><input type="checkbox" name="${param.dom}"${
          param.change === undefined ? '' : html` data-action="${param.change}"`
        }${typed === 'on' ? ' checked' : ''}> ${param.label}</label>`;
      }
      const chosen = param.options.some((each) => each.value === typed) ? typed : param.initial;
      return html`<label class="lbl">${param.label} <select name="${param.dom}">${param.options.map(
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
  const { pending } = act;
  const armed =
    pending !== undefined && !pending.sent && pending.id === def.id && sameSubject(pending.subject, subject);
  const values = act.drafts[def.id] ?? {};
  const label = armed && def.confirm !== undefined ? def.confirm(subject, values, source) : def.label(subject);
  const params = def.params(subject, source).map((param) => field(param, values));
  return wrap(
    html`${params}<button class="${options.class ?? 'btn'}${armed ? ' armed' : ''}" data-action="${def.id}"${
      options.data === true ? dataOf(subject) : ''
    }${options.title === undefined ? '' : html` title="${options.title}"`}>${label}</button>`,
  );
}

/** The text of the last result shown at `place`, and, where `scope` names them, for that repository and workflow. */
export function resultOf(
  act: ActState,
  place: ActPlace,
  scope: { repo?: string; workflow?: string } = {},
): string | undefined {
  const result = act.results[place];
  if (result === undefined) return undefined;
  const { subject } = result;
  const repo = 'repo' in subject ? subject.repo : undefined;
  const workflow = 'workflow' in subject ? subject.workflow : undefined;
  if (scope.repo !== undefined && repo !== scope.repo) return undefined;
  if (scope.workflow !== undefined && workflow !== scope.workflow) return undefined;
  return result.text;
}
