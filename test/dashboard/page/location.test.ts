import { expect, test } from 'bun:test';
import { fromQuery, toQuery } from '../../../src/dashboard/page/location';
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

const asked = (query: string) => Object.fromEntries(new URLSearchParams(query));

test('fromQuery reads each parameter, decoded', () => {
  expect(fromQuery(asked('repo=alpha&run=r&key=implement%231&tab=files&timeline=1&file=k%2Fout%2Fx.md'))).toEqual({
    repo: 'alpha',
    run: 'r',
    key: 'implement#1',
    tab: 'files',
    timeline: true,
    file: 'k/out/x.md',
  });
  expect(fromQuery(asked('repo=alpha&run=r'))).toEqual({ repo: 'alpha', run: 'r', tab: 'overview', timeline: false });
});

test('fromQuery falls back to overview for an unknown tab, and reads timeline only as 1', () => {
  expect(fromQuery(asked('repo=a&run=r&key=k&tab=bogus&timeline=true')).tab).toBe('overview');
  expect(fromQuery(asked('repo=a&run=r&key=k&timeline=true')).timeline).toBe(false);
  expect(fromQuery(asked('repo=a&run=r&key=k&timeline=1')).timeline).toBe(true);
});

test('fromQuery drops the call, tab, timeline and file when a queue is named', () => {
  expect(fromQuery(asked('queue=beta%2Ft&repo=a&run=r&key=k&tab=files&timeline=1&file=f'))).toEqual({
    queue: 'beta/t',
    tab: 'overview',
    timeline: false,
  });
});

test('a query read back gives the selection it was written from', () => {
  const state = ui({ repo: 'a', runId: 'r', key: 'k#1', tab: 'log', timeline: true, file: { name: 'x', path: 'p/x' } });
  expect(fromQuery(asked(toQuery(state)))).toEqual({
    repo: 'a',
    run: 'r',
    key: 'k#1',
    tab: 'log',
    timeline: true,
    file: 'p/x',
  });
});
