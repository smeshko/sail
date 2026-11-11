// The command menu's highlight: where it rests when the row asked for is missing or disabled.
import { expect, test } from 'bun:test';
import { highlighted } from '../../../src/dashboard/page/menu';
import type { MenuModel, MenuRow } from '../../../src/dashboard/page/menu-model';

const row = (label: string, disabled = false): MenuRow => ({
  group: 'subject',
  label,
  disabled,
  run: { view: 'x' },
});

test('the highlight stays on an enabled row, and moves to the first enabled one when its row is disabled or gone', () => {
  const model: MenuModel = { rows: [row('a', true), row('b'), row('c')] };
  expect(highlighted(model, 2)).toBe(2);
  expect(highlighted(model, 0)).toBe(1);
  expect(highlighted(model, 9)).toBe(1);
});

test('with every row disabled, or none, there is no highlight', () => {
  expect(highlighted({ rows: [row('a', true)] }, 0)).toBe(-1);
  expect(highlighted({ rows: [] }, 0)).toBe(-1);
});
