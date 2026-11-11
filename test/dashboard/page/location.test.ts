import { expect, test } from 'bun:test';
import { toQuery } from '../../../src/dashboard/page/location';
import { initialUi, type UiState } from '../../../src/dashboard/page/ui-state';

const ui = (over: Partial<UiState>): UiState => ({ ...initialUi(0), ...over });

test('an empty state has an empty query', () => {
  expect(toQuery(ui({}))).toBe('');
  expect(toQuery(ui({ repo: 'alpha' }))).toBe('');
});

test('a run alone is its repo and run', () => {
  expect(toQuery(ui({ repo: 'alpha', runId: 'FAKE-1-x' }))).toBe('repo=alpha&run=FAKE-1-x');
});

test('a selected call adds its key, encoded', () => {
  expect(toQuery(ui({ repo: 'alpha', runId: 'r', key: 'implement#1' }))).toBe('repo=alpha&run=r&key=implement%231');
});

test('a tab other than overview is named, overview is left out', () => {
  expect(toQuery(ui({ repo: 'a', runId: 'r', key: 'k#1', tab: 'files' }))).toBe('repo=a&run=r&key=k%231&tab=files');
  expect(toQuery(ui({ repo: 'a', runId: 'r', key: 'k#1', tab: 'overview' }))).toBe('repo=a&run=r&key=k%231');
});

test('the timeline adds timeline=1 and a file adds its path, in that order', () => {
  expect(
    toQuery(
      ui({
        repo: 'a',
        runId: 'r',
        key: 'k#1',
        tab: 'files',
        timeline: true,
        file: { name: 'x.md', path: 'k/out/x.md' },
      }),
    ),
  ).toBe('repo=a&run=r&key=k%231&tab=files&timeline=1&file=k%2Fout%2Fx.md');
});

test('a queue is named alone, whatever the run beneath it', () => {
  expect(toQuery(ui({ repo: 'a', runId: 'r', key: 'k#1', queue: 'beta/ticket-to-pr' }))).toBe(
    'queue=beta%2Fticket-to-pr',
  );
});
