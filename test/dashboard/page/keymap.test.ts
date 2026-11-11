// The keys, declared once (ADW-523): the navigation table and the registry's keys are what the handler reads and what
// the shortcut sheet lists, so each key handled is listed, each listed key is handled, and no two keys collide.
import { expect, test } from 'bun:test';
import { ACTIONS, type ActionDef } from '../../../src/dashboard/page/action-registry';
import {
  actionKeys,
  groupOf,
  KEY_GROUPS,
  keyLabel,
  keyLabels,
  LEADS,
  NAV,
  navOf,
  withKey,
} from '../../../src/dashboard/page/keymap';
import { does } from '../../../src/dashboard/page/keys';
import { renderSheet, sheetLines } from '../../../src/dashboard/page/keys-view';

test('every navigation entry has what it does, and the handler has nothing the table does not list', () => {
  expect(Object.keys(does).sort()).toEqual(NAV.map((entry) => entry.id).sort());
});

test('no key is two navigation entries or a navigation entry and an action', () => {
  const nav: string[] = NAV.flatMap((entry) => [...entry.keys]);
  expect(new Set(nav).size).toBe(nav.length);
  expect(actionKeys().filter(({ key }) => nav.includes(key))).toEqual([]);
  for (const key of nav) expect(navOf(key)?.keys).toContain(key);
  expect(navOf('s')).toBeUndefined();
});

test('two actions share a key only when they are done to subjects of different kinds', () => {
  const byKey = new Map<string, ActionDef[]>();
  for (const { def, key } of actionKeys()) byKey.set(key, [...(byKey.get(key) ?? []), def]);
  for (const defs of byKey.values()) {
    const kinds = defs.flatMap((def) => (def.keyIn === undefined ? [...def.appliesTo] : [`view:${def.keyIn}`]));
    expect(new Set(kinds).size).toBe(kinds.length);
  }
  expect(actionKeys().map(({ def, key, variant }) => `${variant ?? def.id} ${key}`)).toEqual([
    'resume-run r',
    'restart-run R',
    'stop-run s',
    'stop-run-now S',
    'clean-run Backspace',
    'requeue-item r',
    'drop-item Backspace',
    'move up Alt+ArrowUp',
    'move down Alt+ArrowDown',
    'move to the top T',
    'poll-queue p',
    'add-ticket c',
    'clear-attention E',
    'dismiss-attention e',
  ]);
});

test('the sheet lists every navigation key and every action key once, in the five groups', () => {
  const lines = sheetLines();
  expect(lines.map((each) => each.group)).toEqual([...KEY_GROUPS]);
  const listed = lines.flatMap((each) => each.lines.flatMap((line) => [...line.keys]));
  expect(listed.sort()).toEqual(
    [...NAV.flatMap((entry) => [...entry.keys]), ...actionKeys().map(({ key }) => key)].sort(),
  );
  expect(lines.find((each) => each.group === 'Run')?.lines.slice(0, 2)).toEqual([
    { text: 'resume', keys: ['r'] },
    { text: 'restart', keys: ['R'] },
  ]);
  expect(lines.find((each) => each.group === 'Queue item')?.lines).toContainEqual({
    text: 'move to the top',
    keys: ['T'],
  });
  expect(keyLabel('T')).toBe('⇧T');
  expect(groupOf(ACTIONS.find((def) => def.id === 'poll-queue') as ActionDef)).toBe('Queue item');
  expect(groupOf(ACTIONS.find((def) => def.id === 'dismiss-attention') as ActionDef)).toBe('Inbox');
});

test('a group with no key is left out of the sheet', () => {
  const markup = renderSheet([]).value;
  expect(markup).not.toContain('<div class="cmdk-grp">Queue item</div>');
  expect(markup).toContain('<div class="cmdk-grp">Run</div>');
  expect(markup).toContain('data-action="close-sheet"');
});

test('a key is drawn as the boxes of its keys', () => {
  expect(
    ['s', 'S', 'Backspace', 'Alt+ArrowUp', 'Alt+ArrowDown', 'Mod+k', 'Mod+.', 'g q', 'Escape', 'Enter', '?', '['].map(
      keyLabel,
    ),
  ).toEqual(['S', '⇧S', '⌫', '⌥↑', '⌥↓', '⌘K', '⌘.', 'G Q', 'Esc', '↵', '?', '[']);
  expect(keyLabels('g i')).toEqual(['G', 'I']);
  expect([withKey('stop', 's'), withKey('copy link', undefined)]).toEqual(['stop (S)', 'copy link']);
  expect([...LEADS]).toEqual(['g']);
});
