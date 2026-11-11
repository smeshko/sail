// The command menu's markup: the head, the field, the rows with the highlighted one marked, a disabled row and its
// reason, the context menu at the pointer with no field, and what a hostile string can't do.
import { expect, test } from 'bun:test';
import type { MenuModel } from '../../../src/dashboard/page/menu-model';
import { renderMenu } from '../../../src/dashboard/page/menu-view';
import type { MenuState } from '../../../src/dashboard/page/ui-state';

const row = (label: string, extra: Partial<MenuModel['rows'][number]> = {}): MenuModel['rows'][number] => ({
  group: 'subject',
  label,
  disabled: false,
  run: { view: 'x' },
  ...extra,
});
const state = (fields: Partial<MenuState> = {}): MenuState => ({
  mode: 'full',
  query: '',
  at: 1,
  steps: [],
  ...fields,
});

test('the full menu draws the head, a field, one row per row with the highlight, and a heading for each other group', () => {
  const model: MenuModel = {
    head: 'run R1',
    rows: [
      row('stop'),
      row('clean', { key: 'c' }),
      row('R1', { group: 'goto', hint: 'run' }),
      row('switch theme', { group: 'general' }),
    ],
  };
  const markup = renderMenu(state(), model).value;
  expect(markup).toContain('<div class="cmdk-subj">run R1</div>');
  expect(markup).toContain('<input class="cmdk-in" name="menu-query" type="text" value=""');
  expect(markup).toContain(
    '<button class="cmdk-row sel" type="button" data-action="menu-run" data-row="1"><span class="cmdk-label">clean</span><kbd>c</kbd></button>',
  );
  expect(markup).toContain(
    '<div class="cmdk-grp">go to</div><button class="cmdk-row" type="button" data-action="menu-run" data-row="2"><span class="cmdk-label">R1</span><span class="cmdk-hint">run</span>',
  );
  expect(markup).toContain('<div class="cmdk-grp">general</div>');
  expect(markup).toContain('<button class="cmdk-back" type="button" data-action="menu-close"');
  expect(markup.match(/class="cmdk-row/g)).toHaveLength(4);
});

test('a disabled row is disabled and says why, and no head means no subject line', () => {
  const markup = renderMenu(state({ at: 0 }), {
    rows: [row('stop', { disabled: true, why: 'it already ended' })],
  }).value;
  expect(markup).toContain(
    'data-row="0" disabled><span class="cmdk-label">stop</span><span class="cmdk-why">it already ended</span>',
  );
  expect(markup).not.toContain('cmdk-subj');
});

test('context mode is placed at the pointer and has no field', () => {
  const markup = renderMenu(state({ mode: 'context', point: { x: 240.4, y: 120 } }), {
    head: 'item k',
    rows: [row('drop')],
  }).value;
  expect(markup).toContain(
    '<div class="cmdk ctx" role="dialog" aria-label="command menu" tabindex="-1" style="left:240px;top:120px">',
  );
  expect(markup).not.toContain('<input');
});

test('a typed step draws its label, its lines and a field of its type; a choice step draws none; an error shows', () => {
  const typed = renderMenu(state({ error: 'give the dollars' }), {
    rows: [],
    step: { label: 'raise $', field: { type: 'number', min: 0.01 }, lines: ['spent $1.00'], rows: [], start: 0 },
  }).value;
  expect(typed).toContain('<div class="cmdk-step">raise $</div><div class="cmdk-line">spent $1.00</div>');
  expect(typed).toContain('type="number"');
  expect(typed).toContain('min="0.01"');
  expect(typed).toContain('<div class="cmdk-err">give the dollars</div>');
  const choice = renderMenu(state(), {
    rows: [row('spec')],
    step: { label: 'from', lines: [], rows: [row('spec')], start: 0 },
  }).value;
  expect(choice).not.toContain('<input');
});

test('a hostile label, reason and query are escaped', () => {
  const markup = renderMenu(state({ query: '"><script>' }), {
    head: '<b>x</b>',
    rows: [row('<img src=x>', { disabled: true, why: '<i>no</i>' })],
  }).value;
  expect(markup).not.toContain('<script>');
  expect(markup).not.toContain('<img');
  expect(markup).not.toContain('<b>x');
  expect(markup).not.toContain('<i>no');
});
