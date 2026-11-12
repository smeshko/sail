// The dashboard's case rule (CONTEXT.md, Case rule): case lives in the strings. Actions, their buttons, rows and
// dialog titles are lowercase; headings, view names and step labels are sentence case; only the small labels the
// stylesheet pins uppercase by CSS, and no CSS rule transforms the first letter or capitalizes a word: the menu's
// one render-time capital is sentence(), on a step label, its placeholder and a group heading.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ACTIONS } from '../../../src/dashboard/page/action-registry';
import { renderEmpty } from '../../../src/dashboard/page/empty-view';
import { KEY_GROUPS, NAV } from '../../../src/dashboard/page/keymap';
import { renderSheet } from '../../../src/dashboard/page/keys-view';
import { VIEW_LABELS } from '../../../src/dashboard/page/list-view';
import type { MenuModel } from '../../../src/dashboard/page/menu-model';
import { renderMenu } from '../../../src/dashboard/page/menu-view';
import type { MenuState } from '../../../src/dashboard/page/ui-state';

const html = readFileSync(new URL('../../../src/dashboard/page/index.html', import.meta.url), 'utf8');
const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

/** The rules of a stylesheet as [selector list, body] pairs, at-rule blocks flattened. */
const rulesIn = (sheet: string): [string, string][] =>
  [...sheet.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(([, sel, body]) => [(sel as string).trim(), body as string]);

/** The selectors of every rule in `sheet` that transforms case. */
const transforming = (sheet: string): string[] =>
  rulesIn(sheet)
    .filter(([, body]) => /text-transform\s*:/.test(body))
    .map(([sel]) => sel);

const state: MenuState = { mode: 'full', query: '', at: 0, steps: [] };

describe('the case rule (ADW-548)', () => {
  test('an action label starts with a lowercase letter or a symbol', () => {
    const labels = ACTIONS.map((def) => def.label({ kind: 'none' }));
    expect(labels.length).toBeGreaterThan(10);
    expect(labels.filter((label) => /^[A-Z]/.test(label))).toEqual([]);
  });

  test('a navigation key text starts with a lowercase letter or a symbol', () => {
    expect(NAV.filter((entry) => /^[A-Z]/.test(entry.text)).map((entry) => entry.text)).toEqual([]);
  });

  test('view names, key groups and the empty centre headlines are sentence case', () => {
    const sentence = /^[A-Z][^A-Z]*$/;
    const headlines = (['inbox', 'active', 'queues', 'history'] as const).map(
      (view) => />([^<]+)<\/div><div class="empty-c"/.exec(renderEmpty(view, [], undefined, 1).value)?.[1] ?? '',
    );
    expect(headlines.every((each) => each !== '')).toBe(true);
    expect([...Object.values(VIEW_LABELS), ...KEY_GROUPS, ...headlines].filter((each) => !sentence.test(each))).toEqual(
      [],
    );
  });

  test('the menu headings and the sheet title are sentence case in the markup', () => {
    const model: MenuModel = {
      rows: [
        { group: 'goto', label: 'Inbox', disabled: false, run: { view: 'inbox' } },
        { group: 'general', label: 'poll every queue', disabled: false, run: { pollAll: true } },
      ],
    };
    const menu = renderMenu(state, model).value;
    expect(menu).toContain('<div class="cmdk-grp" id="cmdk-grp-goto" role="presentation">Go to</div>');
    expect(menu).toContain('<div class="cmdk-grp" id="cmdk-grp-general" role="presentation">General</div>');
    expect(renderSheet().value).toContain('<div class="keys-h">Keyboard shortcuts<');
  });

  test('a raise step reads Raise $ as its step and as its placeholder', () => {
    const model: MenuModel = {
      rows: [],
      step: { label: 'raise $', field: { type: 'number', min: 0.01 }, lines: [], rows: [], start: 0 },
    };
    const menu = renderMenu(state, model).value;
    expect(menu).toContain('<div class="cmdk-step">Raise $</div>');
    expect(menu).toContain('placeholder="Raise $"');
  });

  test('a step with its own placeholder reads it in sentence case, as the add ticket step does', () => {
    const model: MenuModel = {
      rows: [],
      step: { label: 'ticket key', field: { type: 'text', placeholder: 'ticket key' }, lines: [], rows: [], start: 0 },
    };
    const menu = renderMenu(state, model).value;
    expect(menu).toContain('<div class="cmdk-step">Ticket key</div>');
    expect(menu).toContain('placeholder="Ticket key"');
  });

  test('the stylesheet transforms case only in the nine pinned whole-label rules, never a first letter or a word', () => {
    const selectors = transforming(style);
    expect(selectors).toHaveLength(9);
    expect(style).not.toContain('::first-letter');
    expect(style).not.toMatch(/text-transform\s*:\s*(capitalize|lowercase)/);
    expect(style.match(/text-transform\s*:\s*uppercase/g)).toHaveLength(9);
  });

  test('the scan flags a rule that transforms case, and one that capitalizes a first letter', () => {
    expect(transforming('.a::first-letter { text-transform: uppercase; } .b { color: red; }')).toEqual([
      '.a::first-letter',
    ]);
    expect(transforming('.b { color: red; }')).toEqual([]);
  });
});
