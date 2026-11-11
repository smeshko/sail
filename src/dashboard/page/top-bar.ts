// The top bar's buttons and the view actions' words, declared once: the bar, the shortcut sheet and the command menu
// read them, so each action has one name and one icon. Pure.
import { html, type SafeHtml } from './html';
import { type IconName, icon } from './icons';
import { withKey } from './keymap';

/** A view action: what the page says for it, the icon it draws and the key that does it. */
export interface ViewAction {
  label: string;
  icon: IconName;
  key?: string;
}

export const VIEW_ACTIONS = {
  'toggle-sidebar': { label: 'sidebar', icon: 'sidebar' },
  'copy-link': { label: 'copy link', icon: 'link' },
  'toggle-theme': { label: 'switch theme', icon: 'sun' },
  'toggle-inspector': { label: 'pin inspector', icon: 'panel', key: 'i' },
} as const satisfies Record<string, ViewAction>;

export type ViewActionId = keyof typeof VIEW_ACTIONS;

/** The top bar's button for a view action: its icon, its label as the accessible name and its tooltip with its key. */
export function topButton(id: ViewActionId): SafeHtml {
  const action: ViewAction = VIEW_ACTIONS[id];
  const tip = withKey(action.label, action.key);
  const glyph = icon(action.icon, 'ico');
  if (id === 'toggle-sidebar') {
    return html`<button class="btn sidebar-btn" type="button" data-action="${id}" aria-label="${action.label}" title="${tip}">${glyph}</button>`;
  }
  if (id === 'toggle-inspector') {
    return html`<button id="pin-inspector" class="btn" type="button" data-action="${id}" aria-label="${action.label}" aria-pressed="false" title="${tip}">${glyph}</button>`;
  }
  return html`<button class="btn" type="button" data-action="${id}" aria-label="${action.label}" title="${tip}">${glyph}</button>`;
}
