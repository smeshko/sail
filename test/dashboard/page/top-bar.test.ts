// The top bar: its four buttons draw the menu's icons, and the view actions have one wording everywhere (ADW-548).
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { ICONS } from '../../../src/dashboard/page/icons';
import { NAV } from '../../../src/dashboard/page/keymap';
import { generalRows } from '../../../src/dashboard/page/menu-model';
import { topButton, VIEW_ACTIONS } from '../../../src/dashboard/page/top-bar';

const dir = new URL('../../../src/dashboard/page/', import.meta.url);
const html = readFileSync(new URL('index.html', dir), 'utf8');
const sources = [...readdirSync(dir).filter((name) => /\.(ts|html)$/.test(name))].map((name): [string, string] => [
  name,
  readFileSync(new URL(name, dir), 'utf8'),
]);

/** The files of `files` that hold any of `words`. */
const holding = (files: [string, string][], words: string[]): string[] =>
  files.filter(([, text]) => words.some((word) => text.includes(word))).map(([name]) => name);

test('index.html holds the exact markup topButton draws for the sidebar, theme and inspector buttons', () => {
  for (const id of ['toggle-sidebar', 'toggle-theme', 'toggle-inspector'] as const) {
    expect(html).toContain(topButton(id).value);
  }
});

test('the inspector toggle says pin inspector and its tooltip names its key', () => {
  const button = topButton('toggle-inspector').value;
  expect(button).toContain('id="pin-inspector"');
  expect(button).toContain('aria-label="pin inspector" aria-pressed="false" title="pin inspector (I)"');
});

test('the theme toggle says switch theme as its label and its title', () => {
  expect(topButton('toggle-theme').value).toContain('aria-label="switch theme" title="switch theme"');
});

test('every top bar button draws an svg of the shared icon set and no glyph', () => {
  for (const id of ['toggle-sidebar', 'copy-link', 'toggle-theme', 'toggle-inspector'] as const) {
    const button = topButton(id).value;
    expect(button).toContain(
      `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="${ICONS[VIEW_ACTIONS[id].icon]}"/></svg>`,
    );
  }
  expect(topButton('copy-link').value).toContain('aria-label="copy link" title="copy link"');
});

test('the shortcut sheet, the command menu and the top bar word the toggles alike', () => {
  const sheet = NAV.find((entry) => entry.id === 'inspector')?.text;
  const menu = generalRows({ index: [] }).map((row) => row.label);
  expect(sheet).toBe(VIEW_ACTIONS['toggle-inspector'].label);
  expect(menu).toContain(VIEW_ACTIONS['toggle-inspector'].label);
  expect(menu).toContain(VIEW_ACTIONS['toggle-theme'].label);
  expect([VIEW_ACTIONS['toggle-inspector'].label, VIEW_ACTIONS['toggle-theme'].label]).toEqual([
    'pin inspector',
    'switch theme',
  ]);
});

test('no file of the page holds a glyph icon or an old wording', () => {
  const old = ['☰', '⧉', '◐', '⇥', 'toggle inspector', 'pin the inspector'];
  expect(
    holding(
      sources.filter(([name]) => name !== 'top-bar.ts'),
      old,
    ),
  ).toEqual([]);
  expect(holding([['x.ts', "label: 'toggle inspector'"]], old)).toEqual(['x.ts']);
});
