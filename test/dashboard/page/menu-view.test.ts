// The command menu's markup: the head, the field, the rows with the highlighted one marked, a disabled row and its
// reason, the context menu at the pointer with no field, and what a hostile string can't do.
import { describe, expect, test } from 'bun:test';
import type { MenuModel } from '../../../src/dashboard/page/menu-model';
import { iconOf, renderMenu } from '../../../src/dashboard/page/menu-view';
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

describe('audit 2: a reason every row of the subject shares (ADW-544)', () => {
  test('is drawn once, as a quiet line under the chip, and the disabled rows carry none', () => {
    const model: MenuModel = {
      head: 'FAKE-6 · Tidy the docs',
      why: 'no watcher is running',
      rows: [row('drop', { disabled: true }), row('move up', { disabled: true })],
    };
    const markup = renderMenu(state(), model).value;
    expect(markup).toContain(
      '<div class="cmdk-subj">FAKE-6 · Tidy the docs</div><div class="cmdk-note">no watcher is running</div>',
    );
    expect(markup.match(/no watcher is running/g)).toHaveLength(1);
    expect(markup).not.toContain('cmdk-why');
    expect(renderMenu(state(), { rows: model.rows }).value).not.toContain('cmdk-note');
  });

  test('a row with another reason keeps its own beside the shared one: one note and one why', () => {
    const model: MenuModel = {
      head: 'FAKE-6 · Tidy the docs',
      why: 'no watcher is running',
      rows: [row('drop', { disabled: true, why: 'it is running' }), row('move up', { disabled: true })],
    };
    const markup = renderMenu(state(), model).value;
    expect(markup.match(/class="cmdk-note"/g)).toHaveLength(1);
    expect(markup.match(/class="cmdk-why"/g)).toHaveLength(1);
    expect(markup.match(/no watcher is running/g)).toHaveLength(1);
  });
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
    '<button class="cmdk-row sel" type="button" role="option" id="cmdk-opt-1" aria-selected="true" data-action="menu-run" data-row="1"><span class="cmdk-label">clean</span><kbd>C</kbd><svg class="cmdk-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg></button>',
  );
  expect(markup).toContain(
    '<div class="cmdk-grp" id="cmdk-grp-goto" role="presentation">go to</div><button class="cmdk-row" type="button" role="option" id="cmdk-opt-2" aria-selected="false" data-action="menu-run" data-row="2"><span class="cmdk-label">R1</span><span class="cmdk-hint">run</span>',
  );
  expect(markup).toContain('<div class="cmdk-grp" id="cmdk-grp-general" role="presentation">general</div>');
  expect(markup).toContain('<button class="cmdk-back" type="button" data-action="menu-close"');
  expect(markup.match(/class="cmdk-row[ "]/g)).toHaveLength(4);
  // The rows scroll in their own box, after the chip and the field, which stay (ADW-542).
  expect(markup).toMatch(
    /<div class="cmdk-subj">.*<input class="cmdk-in".*<div class="cmdk-rows" id="cmdk-rows" data-scroll="menu-rows"[^>]*><button class="cmdk-row"/,
  );
});

test("a run's go-to row draws the list's dot, its key and its title after its icon", () => {
  const run = row('Fix the parser', {
    group: 'goto',
    hint: 'alpha › ticket-to-pr',
    lead: 'FAKE-1',
    status: 'failed',
    run: { goto: { kind: 'run', repo: 'alpha', runId: 'FAKE-1-AAA' } },
  });
  const dot = '<span class="st p-fail"></span><span class="cmdk-key">FAKE-1</span>';
  const tail = '<span class="cmdk-label">Fix the parser</span><span class="cmdk-hint">alpha › ticket-to-pr</span>';
  const plain = renderMenu(state({ at: 0 }), { rows: [run] }).value;
  expect(plain).toContain(`data-row="0">${dot}${tail}<svg class="cmdk-ico"`);
  expect(plain).not.toContain('cmdk-id');
  const twin = renderMenu(state({ at: 0 }), { rows: [{ ...run, id: 'AAA' }] }).value;
  expect(twin).toContain(`${dot}<span class="cmdk-id">AAA</span>${tail}`);
  const hostile = renderMenu(state({ at: 0 }), { rows: [{ ...run, label: '<b>x</b>' }] }).value;
  expect(hostile).toContain('<span class="cmdk-label">&lt;b&gt;x&lt;/b&gt;</span>');
});

test('a disabled row is disabled and says why, and no head means no subject line', () => {
  const markup = renderMenu(state({ at: 0 }), {
    rows: [row('stop', { disabled: true, why: 'it already ended' })],
  }).value;
  expect(markup).toContain(
    'data-row="0" disabled aria-disabled="true"><span class="cmdk-label">stop</span><span class="cmdk-why">it already ended</span>',
  );
  expect(markup).not.toContain('cmdk-subj');
});

test('context mode is placed at the pointer and has no field', () => {
  const markup = renderMenu(state({ mode: 'context', point: { x: 240.4, y: 120 } }), {
    head: 'item k',
    rows: [row('drop')],
  }).value;
  expect(markup).toContain(
    '<div class="cmdk ctx" role="dialog" aria-modal="true" aria-label="command menu" tabindex="-1" style="left:240px;top:120px">',
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

test('a row leads with the icon of what it runs, and an arrow when it has none of its own', () => {
  const none = { kind: 'none' } as const;
  const act = (id: string) => iconOf({ act: id, subject: none, data: {} });
  expect(['resume-run', 'stop-run', 'unwatch', 'watch', 'clean-run', 'other'].map(act)).toEqual([
    'play',
    'stop',
    'eyeOff',
    'eye',
    'trash',
    'arrow',
  ]);
  expect(['restart-run', 'start-run-go'].map(act)).toEqual(['restart', 'run']);
  expect(iconOf({ goto: { kind: 'run', repo: 'a', runId: 'r' } })).toBe('run');
  expect(iconOf({ goto: none })).toBe('arrow');
  expect(['toggle-theme', 'toggle-inspector', 'x'].map((view) => iconOf({ view }))).toEqual(['sun', 'panel', 'arrow']);
  expect(iconOf({ pollAll: true })).toBe('refresh');
  expect(iconOf({ pick: 'add-ticket' })).toBe('plus');
  expect(iconOf({ pick: 'start-run', of: 'repo' })).toBe('run');
  expect(iconOf({ repo: 'a' })).toBe('folder');
  expect(iconOf({ queue: { repo: 'a', workflow: 'w' } })).toBe('list');
  expect(iconOf({ value: 'spec' })).toBe('arrow');
});

describe('the command menu is a combobox over a listbox of options (ADW-547)', () => {
  const full: MenuModel = {
    head: 'run R1',
    rows: [
      row('stop'),
      row('clean', { disabled: true, why: 'it is running' }),
      row('Inbox', { group: 'goto' }),
      row('Active', { group: 'goto' }),
      row('switch theme', { group: 'general' }),
    ],
  };
  const selected = (markup: string) => [...markup.matchAll(/<button[^>]*aria-selected="true"[^>]*>/g)].map((m) => m[0]);

  test('the field is a combobox that controls the listbox and names the highlighted row, for the first row and a later one', () => {
    for (const at of [0, 3]) {
      const markup = renderMenu(state({ at }), full).value;
      expect(markup).toContain(
        `role="combobox" aria-controls="cmdk-rows" aria-autocomplete="list" aria-expanded="true" aria-activedescendant="cmdk-opt-${at}"`,
      );
      expect(markup).toContain('<div class="cmdk-rows" id="cmdk-rows" data-scroll="menu-rows" role="listbox"');
      const picked = selected(markup);
      expect(picked).toHaveLength(1);
      expect(picked[0]).toContain(`id="cmdk-opt-${at}"`);
      expect(markup.match(/role="option"/g)).toHaveLength(5);
      expect(markup.match(/aria-selected="false"/g)).toHaveLength(4);
      expect(new Set(markup.match(/id="cmdk-opt-\d"/g)).size).toBe(5);
    }
  });

  test('go to and general rows sit in a group their heading labels; subject rows are the listbox own children', () => {
    const markup = renderMenu(state(), full).value;
    expect(markup).toContain(
      '<div class="cmdk-group" role="group" aria-labelledby="cmdk-grp-goto"><div class="cmdk-grp" id="cmdk-grp-goto" role="presentation">go to</div><button class="cmdk-row" type="button" role="option" id="cmdk-opt-2"',
    );
    expect(markup).toContain(
      '<div class="cmdk-group" role="group" aria-labelledby="cmdk-grp-general"><div class="cmdk-grp" id="cmdk-grp-general" role="presentation">general</div><button class="cmdk-row" type="button" role="option" id="cmdk-opt-4"',
    );
    expect(markup).toMatch(
      /aria-label="commands"><button class="cmdk-row[^"]*" type="button" role="option" id="cmdk-opt-0"/,
    );
    expect(markup.match(/class="cmdk-group"/g)).toHaveLength(2);
  });

  test('a disabled row is an option with aria-disabled and its reason', () => {
    const markup = renderMenu(state(), full).value;
    expect(markup).toMatch(
      /id="cmdk-opt-1"[^>]* disabled aria-disabled="true"><span class="cmdk-label">clean<\/span>.*<span class="cmdk-why">it is running<\/span>/,
    );
    expect(markup.match(/aria-disabled/g)).toHaveLength(1);
  });

  test('context mode and a choice step draw no input, and the listbox takes the focus and names the highlighted row', () => {
    const context = renderMenu(state({ mode: 'context', at: 1 }), full).value;
    expect(context).not.toContain('<input');
    expect(context).toContain('role="listbox" aria-label="commands" tabindex="-1" aria-activedescendant="cmdk-opt-1"');
    const choice = renderMenu(state({ at: 0 }), {
      rows: [row('spec')],
      step: { label: 'from', lines: [], rows: [row('spec')], start: 0 },
    }).value;
    expect(choice).toContain('role="listbox" aria-label="commands" tabindex="-1" aria-activedescendant="cmdk-opt-0"');
  });

  test('the full menu with a field never makes the listbox focusable', () => {
    expect(renderMenu(state(), full).value).not.toContain('tabindex="-1" aria-activedescendant');
  });

  test('a number step field, and a text field with no rows under it, are no combobox', () => {
    const number = renderMenu(state(), {
      rows: [],
      step: { label: 'raise $', field: { type: 'number' }, lines: [], rows: [], start: 0 },
    }).value;
    const text = renderMenu(state(), {
      rows: [],
      step: { label: 'name', field: { type: 'text' }, lines: [], rows: [], start: 0 },
    }).value;
    for (const markup of [number, text]) {
      expect(markup).not.toContain('role="combobox"');
      expect(markup).not.toContain('aria-controls');
      expect(markup).not.toContain('aria-activedescendant');
    }
    expect(number).toContain('<div class="cmdk-rows" id="cmdk-rows" data-scroll="menu-rows"></div>');
  });

  test('a text step field with rows under it is a combobox', () => {
    const markup = renderMenu(state({ at: 0 }), {
      rows: [row('a')],
      step: { label: 'name', field: { type: 'text' }, lines: [], rows: [row('a')], start: 0 },
    }).value;
    expect(markup).toContain('role="combobox" aria-controls="cmdk-rows"');
    expect(markup).toContain('aria-activedescendant="cmdk-opt-0"');
  });

  test('a menu with no rows has a box with no role, and its field says it is collapsed with nothing highlighted', () => {
    const markup = renderMenu(state({ at: 0 }), { rows: [] }).value;
    expect(markup).toContain('<div class="cmdk-rows" id="cmdk-rows" data-scroll="menu-rows"></div>');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('aria-activedescendant');
  });
});
