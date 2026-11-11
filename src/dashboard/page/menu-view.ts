// The command menu's markup, from its state and the model `menu-model.ts` made. Pure. A row is a button whose
// `data-action` is `menu-run` and whose `data-row` is its place in the rows; a disabled one is `disabled` and says why.
// A run's go-to row leads with the list's status dot, its ticket key or pull request and, to tell two alike apart, the random part of its run id.
// The context menu is the subject's rows at the pointer with no field. The back button behind the menu closes it.
import { html, raw, type SafeHtml } from './html';
import { keyLabel } from './keymap';
import type { MenuModel, MenuRow } from './menu-model';
import { type MenuState, pillOf } from './ui-state';

const HEADINGS: Partial<Record<MenuRow['group'], string>> = { goto: 'go to', general: 'general' };

// The icons' paths, on a 16px grid, drawn as strokes in the row's colour.
const ICONS: Record<string, string> = {
  play: 'M5 3.5v9l7-4.5z',
  stop: 'M4 4h8v8H4z',
  restart: 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5',
  refresh: 'M2.5 8a5.5 5.5 0 0 1 9.5-3.5M13.5 8a5.5 5.5 0 0 1-9.5 3.5M12 2v2.5H9.5M4 14v-2.5h2.5',
  unlock: 'M4 7.5h8v6H4zM6 7.5V5a2 2 0 0 1 4 0',
  plus: 'M8 3v10M3 8h10',
  check: 'M3 8.5l3.5 3.5L13 4.5',
  cross: 'M4 4l8 8M12 4l-8 8',
  move: 'M8 2.5v11M5 5.5l3-3 3 3M5 10.5l3 3 3-3',
  eye: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
  eyeOff:
    'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM2.5 2.5l11 11',
  folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  ticket: 'M2.5 5h11v2a1 1 0 0 0 0 2v2h-11V9a1 1 0 0 0 0-2z',
  run: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM6.8 5.8v4.4L10.3 8z',
  sun: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1',
  panel: 'M2 3h12v10H2zM10 3v10',
  arrow: 'M3 8h10M9 4l4 4-4 4',
};

// The first word of an action's id that names an icon, in the order tried: `unwatch` before `watch`.
const BY_ACTION: [string, string][] = [
  ['resume', 'play'],
  ['restart', 'restart'],
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
const BY_KIND: Record<string, string> = { run: 'run', item: 'ticket', workflow: 'list', repo: 'folder' };

/** The icon a row leads with, from what it runs: an arrow for anything with none of its own. */
export function iconOf(run: MenuRow['run']): string {
  if ('act' in run) return BY_ACTION.find(([word]) => run.act.includes(word))?.[1] ?? 'arrow';
  if ('goto' in run) return BY_KIND[run.goto.kind] ?? 'arrow';
  if ('view' in run) return run.view === 'toggle-theme' ? 'sun' : run.view === 'toggle-inspector' ? 'panel' : 'arrow';
  if ('pollAll' in run) return 'refresh';
  if ('pick' in run) return BY_ACTION.find(([word]) => run.pick.includes(word))?.[1] ?? 'plus';
  if ('repo' in run) return 'folder';
  return 'queue' in run ? 'list' : 'arrow';
}

// The icon comes last in the markup and first on screen (`order: -1`), so a row still starts with its label.
const icon = (run: MenuRow['run']): SafeHtml =>
  raw(`<svg class="cmdk-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="${ICONS[iconOf(run)]}"/></svg>`);

function row(item: MenuRow, place: number, state: MenuState): SafeHtml {
  return html`<button class="cmdk-row${place === state.at ? ' sel' : ''}" type="button" data-action="menu-run" data-row="${place}"${
    item.disabled ? ' disabled' : ''
  }>${
    item.lead === undefined
      ? ''
      : html`<span class="st ${pillOf(item.status)}"></span><span class="cmdk-key">${item.lead}</span>${
          item.id === undefined ? '' : html`<span class="cmdk-id">${item.id}</span>`
        }`
  }<span class="cmdk-label">${item.label}</span>${item.hint === undefined ? '' : html`<span class="cmdk-hint">${item.hint}</span>`}${
    item.disabled && item.why !== undefined ? html`<span class="cmdk-why">${item.why}</span>` : ''
  }${item.key === undefined ? '' : html`<kbd>${keyLabel(item.key)}</kbd>`}${icon(item.run)}</button>`;
}

function field(state: MenuState, model: MenuModel): SafeHtml | '' {
  const step = model.step;
  if (step === undefined) {
    if (state.mode === 'context') return '';
    return html`<input class="cmdk-in" name="menu-query" type="text" value="${state.query}" placeholder="Type a command or search…" aria-label="command menu" autocomplete="off" spellcheck="false">`;
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
