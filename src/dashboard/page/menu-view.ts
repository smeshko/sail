// The command menu's markup, from its state and the model `menu-model.ts` made. Pure. A row is a button whose
// `data-action` is `menu-run` and whose `data-row` is its place in the rows; a disabled one is `disabled` and says why.
// The context menu is the subject's rows at the pointer with no field. The back button behind the menu closes it.
import { html, type SafeHtml } from './html';
import type { MenuModel, MenuRow } from './menu-model';
import type { MenuState } from './ui-state';

const HEADINGS: Partial<Record<MenuRow['group'], string>> = { goto: 'go to', general: 'general' };

function row(item: MenuRow, place: number, state: MenuState): SafeHtml {
  return html`<button class="cmdk-row${place === state.at ? ' sel' : ''}" type="button" data-action="menu-run" data-row="${place}"${
    item.disabled ? ' disabled' : ''
  }><span class="cmdk-label">${item.label}</span>${item.hint === undefined ? '' : html`<span class="cmdk-hint">${item.hint}</span>`}${
    item.disabled && item.why !== undefined ? html`<span class="cmdk-why">${item.why}</span>` : ''
  }${item.key === undefined ? '' : html`<kbd>${item.key}</kbd>`}</button>`;
}

function field(state: MenuState, model: MenuModel): SafeHtml | '' {
  const step = model.step;
  if (step === undefined) {
    if (state.mode === 'context') return '';
    return html`<input class="cmdk-in" name="menu-query" type="text" value="${state.query}" placeholder="type an action or where to go" aria-label="command menu" autocomplete="off" spellcheck="false">`;
  }
  if (step.field === undefined) return '';
  return html`<input class="cmdk-in" name="menu-query" type="${step.field.type}" value="${state.query}"${
    step.field.min === undefined ? '' : html` min="${step.field.min}"`
  } step="any" placeholder="${step.field.placeholder ?? step.label}" aria-label="${step.label}" autocomplete="off" spellcheck="false">`;
}

export function renderMenu(state: MenuState, model: MenuModel): SafeHtml {
  const style =
    state.mode === 'context' && state.point !== undefined
      ? html` style="left:${Math.round(state.point.x)}px;top:${Math.round(state.point.y)}px"`
      : '';
  let last: MenuRow['group'] | undefined;
  const rows = model.rows.map((item, place) => {
    const heading = item.group !== last && HEADINGS[item.group] !== undefined;
    last = item.group;
    return html`${heading ? html`<div class="cmdk-grp">${HEADINGS[item.group]}</div>` : ''}${row(item, place, state)}`;
  });
  return html`<button class="cmdk-back" type="button" data-action="menu-close" aria-label="close the command menu" tabindex="-1"></button><div class="cmdk${state.mode === 'context' ? ' ctx' : ''}" role="dialog" aria-label="command menu" tabindex="-1"${style}>${
    model.head === undefined ? '' : html`<div class="cmdk-subj">${model.head}</div>`
  }${model.step === undefined ? '' : html`<div class="cmdk-step">${model.step.label}</div>${model.step.lines.map((line) => html`<div class="cmdk-line">${line}</div>`)}`}${field(state, model)}${
    state.error === undefined ? '' : html`<div class="cmdk-err">${state.error}</div>`
  }${rows}</div>`;
}
