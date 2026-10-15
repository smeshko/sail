// The formats every view shares, at each tier's edges. They are built by hand, so every Bun gives the same strings,
// and a time of day is shown at the offset the shell passes, so a snapshot renders the same on every machine.
import { expect, test } from 'bun:test';
import { ago, clock, cost, duration, percent, tokens } from '../../../src/dashboard/page/format';

// biome-ignore format: TDD-PENDING TASK-001
test
  .skip // TDD-PENDING TASK-001
  ('duration gives ms, tenths of a second, minutes and seconds, then hours and minutes, at each edge', () => {
  const at = [0, 999, 1000, 1250, 59_999, 60_000, 184_000, 3_599_999, 3_600_000, 7_500_000];
  expect(at.map(duration)).toEqual([
    '0ms',
    '999ms',
    '1.0s',
    '1.2s',
    '59.9s',
    '1m 0s',
    '3m 4s',
    '59m 59s',
    '1h 0m',
    '2h 5m',
  ]);
  expect([undefined, -1, Number.NaN].map(duration)).toEqual(['—', '—', '—']);
});

// biome-ignore format: TDD-PENDING TASK-001
test
  .skip // TDD-PENDING TASK-001
  ('tokens gives counts, one-decimal and whole thousands, then millions, a k count that rounds to 1000k in millions', () => {
  const at = [0, 999, 1000, 9999, 10_000, 999_499, 999_999, 1_000_000, 9_940_000, 12_345_678];
  expect(at.map(tokens)).toEqual(['0', '999', '1.0k', '10.0k', '10k', '999k', '1.0m', '1.0m', '9.9m', '12m']);
  expect(tokens(undefined)).toBe('?');
});

// biome-ignore format: TDD-PENDING TASK-001
test
  .skip // TDD-PENDING TASK-001
  ('cost, clock, ago and percent', () => {
  expect([0.31, 1.346, 0.004, 0, 25, undefined].map(cost)).toEqual([
    '$0.31',
    '$1.35',
    '$0.004',
    '$0.00',
    '$25.00',
    '—',
  ]);
  const at = '2026-09-25T09:00:01.700Z';
  expect([clock(at, 0), clock(at, 120), clock(at, -570), clock('nope', 0), clock(undefined, 0)]).toEqual([
    '09:00:01',
    '11:00:01',
    '23:30:01',
    '—',
    '—',
  ]);
  const now = Date.parse('2026-09-25T10:00:00.000Z');
  const times = ['2026-09-25T09:59:48Z', '2026-09-25T09:56:00Z', '2026-09-25T07:00:00Z', '2026-09-23T09:00:00Z'];
  expect([...times, '2026-09-25T10:05:00Z', 'nope'].map((iso) => ago(iso, now))).toEqual([
    '12s ago',
    '4m ago',
    '3h ago',
    '2d ago',
    'in 5m',
    '—',
  ]);
  expect([percent(1.35, 25), percent(1.0625, 1), percent(0, 5), percent(1, 0), percent(1, undefined)]).toEqual([
    '5.4%',
    '106.3%',
    '0%',
    '—',
    '—',
  ]);
});
