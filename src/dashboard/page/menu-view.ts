// The command menu's markup, from its state and the model `menu-model.ts` made. Pure. A row is a button whose
// `data-action` is `menu-run` and whose `data-row` is its place in the rows; a disabled one is `disabled` and says why.
// A run's go-to row leads with the list's status dot, its ticket key or pull request and, to tell two alike apart, the random part of its run id.
// The context menu is the subject's rows at the pointer with no field. The back button behind the menu closes it. The
// rows scroll in a box of their own under the chip and the field, which stay.
// The box is a listbox, each row an option and each headed group a `role="group"` its heading labels. The field is a
// combobox naming the highlighted row in `aria-activedescendant`; with no field the listbox is focusable and names it.
import { sentence } from './format';
import { html, raw, type SafeHtml } from './html';
import { type IconName, icon } from './icons';
import { keyLabel } from './keymap';
import type { MenuModel, MenuRow } from './menu-model';
import { VIEW_ACTIONS, type ViewAction } from './top-bar';
import { type MenuState, pillOf } from './ui-state';

const HEADINGS: Partial<Record<MenuRow['group'], string>> = { goto: 'go to', general: 'general' };

// The first word of an action's id that names an icon, in the order tried: `unwatch` before `watch`.
const BY_ACTION: [string, IconName][] = [
  ['resume', 'play'],
  ['restart', 'restart'],
  ['stop-run-now', 'stopNow'],
  ['suspend', 'pause'],
  ['stop', 'stop'],
  ['clean', 'trash'],
  ['drop', 'cross'],
  ['dismiss', 'cross'],
  ['clear', 'check'],
  ['move', 'move'],
  ['poll', 'refresh'],
  ['release', 'unlock'],
  ['add', 'plus'],
  ['start', 'run'],
  ['unwatch', 'eyeOff'],
  ['watch', 'eye'],
];
const BY_KIND: Record<string, IconName> = { run: 'run', item: 'ticket', workflow: 'list', repo: 'folder' };

/** The icon a row leads with, from what it runs: an arrow for anything with none of its own. */
export function iconOf(run: MenuRow['run']): IconName {
  if ('act' in run) return BY_ACTION.find(([word]) => run.act.includes(word))?.[1] ?? 'arrow';
  if ('goto' in run) return BY_KIND[run.goto.kind] ?? 'arrow';
  if ('view' in run) return (VIEW_ACTIONS as Record<string, ViewAction | undefined>)[run.view]?.icon ?? 'arrow';
  if ('pollAll' in run) return 'refresh';
  if ('pick' in run) return BY_ACTION.find(([word]) => run.pick.includes(word))?.[1] ?? 'plus';
  if ('repo' in run) return 'folder';
  return 'queue' in run ? 'list' : 'arrow';
}

// The icon comes last in the markup and first on screen (`order: -1`), so a row still starts with its label.
const rowIcon = (run: MenuRow['run']): SafeHtml => icon(iconOf(run), 'cmdk-ico');

function row(item: MenuRow, place: number, state: MenuState): SafeHtml {
  return html`<button class="cmdk-row${place === state.at ? ' sel' : ''}" type="button" role="option" id="cmdk-opt-${place}" aria-selected="${place === state.at ? 'true' : 'false'}" data-action="menu-run" data-row="${place}"${
    item.disabled ? raw(' disabled aria-disabled="true"') : ''
  }>${
    item.lead === undefined
      ? ''
      : html`<span class="st ${pillOf(item.status)}"></span><span class="cmdk-key">${item.lead}</span>${
          item.id === undefined ? '' : html`<span class="cmdk-id">${item.id}</span>`
        }`
  }<span class="cmdk-label">${item.label}</span>${item.hint === undefined ? '' : html`<span class="cmdk-hint">${item.hint}</span>`}${
    item.disabled && item.why !== undefined ? html`<span class="cmdk-why">${item.why}</span>` : ''
  }${item.key === undefined ? '' : html`<kbd>${keyLabel(item.key)}</kbd>`}${rowIcon(item.run)}</button>`;
}

/** The attributes that make a text field the combobox of the rows' listbox. */
function combo(state: MenuState, model: MenuModel): SafeHtml {
  const open = model.rows.length > 0;
  return html` role="combobox" aria-controls="cmdk-rows" aria-autocomplete="list" aria-expanded="${open ? 'true' : 'false'}"${
    model.rows[state.at] === undefined ? '' : html` aria-activedescendant="cmdk-opt-${state.at}"`
  }`;
}

function field(state: MenuState, model: MenuModel): SafeHtml | '' {
  const step = model.step;
  if (step === undefined) {
    if (state.mode === 'context') return '';
    return html`<input class="cmdk-in" name="menu-query" type="text" value="${state.query}"${combo(state, model)} placeholder="Type a command or search…" aria-label="command menu" autocomplete="off" spellcheck="false">`;
  }
  if (step.field === undefined) return '';
  return html`<input class="cmdk-in" name="menu-query" type="${step.field.type}" value="${state.query}"${
    step.field.type === 'text' && model.rows.length > 0 ? combo(state, model) : ''
  }${step.field.min === undefined ? '' : html` min="${step.field.min}"`} step="any" placeholder="${sentence(step.field.placeholder ?? step.label)}" aria-label="${sentence(step.label)}" autocomplete="off" spellcheck="false">`;
}

export function renderMenu(state: MenuState, model: MenuModel): SafeHtml {
  const style =
    state.mode === 'context' && state.point !== undefined
      ? html` style="left:${Math.round(state.point.x)}px;top:${Math.round(state.point.y)}px"`
      : '';
  // A contiguous run of rows of a headed group sits in a `role="group"` its heading labels; the others are the listbox's own.
  const rows: SafeHtml[] = [];
  for (let place = 0; place < model.rows.length; ) {
    const item = model.rows[place] as MenuRow;
    const heading = HEADINGS[item.group];
    if (heading === undefined) {
      rows.push(row(item, place, state));
      place++;
      continue;
    }
    const inside: SafeHtml[] = [];
    while (model.rows[place]?.group === item.group) {
      inside.push(row(model.rows[place] as MenuRow, place, state));
      place++;
    }
    rows.push(
      html`<div class="cmdk-group" role="group" aria-labelledby="cmdk-grp-${item.group}"><div class="cmdk-grp" id="cmdk-grp-${item.group}" role="presentation">${sentence(heading)}</div>${inside}</div>`,
    );
  }
  const hasField = field(state, model) !== '';
  const listbox =
    model.rows.length === 0
      ? ''
      : html` role="listbox" aria-label="commands"${
          hasField || model.rows[state.at] === undefined
            ? ''
            : html` tabindex="-1" aria-activedescendant="cmdk-opt-${state.at}"`
        }`;
  // The chip, the step and the field stay put: the rows scroll on their own, keeping their place across a redraw.
  return html`<button class="cmdk-back" type="button" data-action="menu-close" aria-label="close the command menu" tabindex="-1"></button><div class="cmdk${state.mode === 'context' ? ' ctx' : ''}" role="dialog" aria-modal="true" aria-label="command menu" tabindex="-1"${style}>${
    model.head === undefined ? '' : html`<div class="cmdk-subj">${model.head}</div>`
  }${model.why === undefined ? '' : html`<div class="cmdk-note">${model.why}</div>`}${model.step === undefined ? '' : html`<div class="cmdk-step">${sentence(model.step.label)}</div>${model.step.lines.map((line) => html`<div class="cmdk-line">${line}</div>`)}`}${field(state, model)}${
    state.error === undefined ? '' : html`<div class="cmdk-err">${state.error}</div>`
  }<div class="cmdk-rows" id="cmdk-rows" data-scroll="menu-rows"${listbox}>${rows}</div></div>`;
}
