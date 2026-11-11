// The formats every view shares, at each tier's edges. They are built by hand, so every Bun gives the same strings,
// and a time of day is shown at the offset the shell passes, so a snapshot renders the same on every machine.
import { describe, expect, test } from 'bun:test';
import {
  ago,
  clock,
  cost,
  dayOf,
  dayOfMs,
  duration,
  fromClone,
  minute,
  percent,
  tokens,
} from '../../../src/dashboard/page/format';

describe('audit 2: rows say what they are (ADW-543)', () => {
  test('minute is clock without its seconds, and a dash for no time', () => {
    expect(minute('2026-10-01T18:52:56.000Z', 60)).toBe('19:52');
    expect(minute(undefined, 0)).toBe('—');
  });

  test('fromClone cuts each absolute path to the part from its .sail/ or .sail-runs/ on, and leaves any other path', () => {
    expect(fromClone('/private/var/T/sail-x/beta/.sail-runs/FAKE-15/STATUS holds "x"')).toBe(
      '.sail-runs/FAKE-15/STATUS holds "x"',
    );
    expect(fromClone('/work/gone/.sail no longer exists; /work/a/.sail/project.yaml too')).toBe(
      '.sail no longer exists; .sail/project.yaml too',
    );
    expect(fromClone('/x/.sail-dashboard/y and /usr/bin stay')).toBe('/x/.sail-dashboard/y and /usr/bin stay');
  });
});

test('duration gives ms, tenths of a second, minutes and seconds, then hours and minutes, at each edge', () => {
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

test('tokens gives counts, thousands with one decimal below 100k, millions with one below 10m, whole above, a k count that rounds to 1000k in millions', () => {
  const at = [
    0, 534, 999, 1000, 9999, 12_600, 99_949, 99_950, 189_200, 999_499, 999_999, 1_000_000, 9_940_000, 9_949_999,
    9_950_000, 99_950_000, 12_345_678, 13_000_000,
  ];
  expect(at.map(tokens)).toEqual([
    '0',
    '534',
    '999',
    '1.0k',
    '10.0k',
    '12.6k',
    '99.9k',
    '100k',
    '189k',
    '999k',
    '1.0m',
    '1.0m',
    '9.9m',
    '9.9m',
    '10m',
    '100m',
    '12m',
    '13m',
  ]);
  expect(tokens(undefined)).toBe('?');
});

test('cost, clock, ago and percent', () => {
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

test('dayOf gives the date at the offset across midnight, and undefined for a missing or invalid time', () => {
  const at = '2026-10-01T23:30:00Z';
  expect([0, 120, -480].map((offset) => dayOf(at, offset))).toEqual(['2026-10-01', '2026-10-02', '2026-10-01']);
  expect(dayOf('2026-10-01T05:00:00Z', -480)).toBe('2026-09-30');
  expect([undefined, 'nope', ''].map((t) => dayOf(t, 0))).toEqual([undefined, undefined, undefined]);
  expect(dayOfMs(Date.parse('2026-01-05T00:00:00Z'), 0)).toBe('2026-01-05');
  expect(dayOfMs(Date.parse('2026-01-05T00:00:00Z'), -1)).toBe('2026-01-04');
});
