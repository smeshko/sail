// The shortcut sheet `?` opens: every key the page handles, grouped, drawn over the page in the command menu's place
// and style. Generated: the navigation keys from `keymap.ts`'s table and the actions' keys from the registry, the same
// two lists the key handler reads, so the sheet can't list a key that does nothing or miss one that does something.
// Pure. The backdrop behind it closes it, as `Escape` and `?` do. Its groups fill columns in order, and its head stays
// while they scroll.
import type { ActionDef } from './action-registry';
import { html, type SafeHtml } from './html';
import { actionKeys, groupOf, KEY_GROUPS, type KeyGroup, keyLabels, NAV, type NavKey } from './keymap';

/** A line of the sheet: what it does and the keys that do it. */
export interface SheetLine {
  text: string;
  keys: readonly string[];
}

/** The sheet's lines by group, in `KEY_GROUPS` order: each group's action keys in the registry's order, then its navigation keys. */
export function sheetLines(registry?: readonly ActionDef[]): { group: KeyGroup; lines: SheetLine[] }[] {
  const acts = actionKeys(registry);
  return KEY_GROUPS.map((group) => ({
    group,
    lines: [
      ...acts
        .filter((each) => groupOf(each.def) === group)
        .map((each) => ({ text: each.variant ?? each.def.label({ kind: 'none' }), keys: [each.key] })),
      ...(NAV as readonly NavKey[])
        .filter((entry) => entry.group === group)
        .map((entry) => ({ text: entry.text, keys: entry.keys })),
    ],
  }));
}

/** One key: a box per key of a sequence, `then` between them. */
const keyBoxes = (key: string): SafeHtml =>
  html`<span class="keys-k">${keyLabels(key).map(
    (label, at) => html`${at === 0 ? '' : html`<span class="keys-then">then</span>`}<kbd>${label}</kbd>`,
  )}</span>`;

export function renderSheet(registry?: readonly ActionDef[]): SafeHtml {
  const groups = sheetLines(registry).filter((each) => each.lines.length > 0);
  return html`<button class="cmdk-back" type="button" data-action="close-sheet" aria-label="close the keyboard shortcuts" tabindex="-1"></button><div class="cmdk keys" role="dialog" aria-modal="true" aria-label="keyboard shortcuts" tabindex="-1"><div class="keys-h">Keyboard shortcuts<span class="keys-close">${keyBoxes('?')} or ${keyBoxes('Escape')} to close</span></div><div class="keys-cols">${groups.map(
    ({ group, lines }) =>
      html`<section class="keys-grp"><div class="cmdk-grp">${group}</div>${lines.map(
        (line) =>
          html`<div class="keys-row"><span class="keys-t">${line.text}</span><span class="keys-ks">${line.keys.map(keyBoxes)}</span></div>`,
      )}</section>`,
  )}</div></div>`;
}
