// How commands print: tables, durations and dollars.
import { expect, test } from 'bun:test';
import { formatDuration, formatUsd, table } from '../../src/cli/format';

test('table pads each column to its widest cell, two spaces apart, and ends no line in whitespace', () => {
  expect(
    table([
      ['key', 'kind', 'next'],
      ['spec#1', 'agent', ''],
      ['  publish#1/open', '', 'end'],
    ]),
  ).toEqual(['key               kind   next', 'spec#1            agent', '  publish#1/open         end']);
});

test.each([
  [0, '0ms'],
  [999, '999ms'],
  [1000, '1.0s'],
  [59_949, '59.9s'],
  [59_950, '1m 0s'],
  [71_135, '1m 11s'],
  [3_599_499, '59m 59s'],
  [3_599_500, '1h 0m'],
  [5_430_000, '1h 30m'],
])('formatDuration(%p) is %p, rounded as the terminal view rounds', (ms, text) => {
  expect(formatDuration(ms)).toBe(text);
});

test.each([
  [0, '$0.00'],
  [0.3125, '$0.31'],
  [1.35, '$1.35'],
  [25, '$25.00'],
])('formatUsd(%p) is %p', (usd, text) => {
  expect(formatUsd(usd)).toBe(text);
});
