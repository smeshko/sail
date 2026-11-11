import { expect, test } from 'bun:test';
import { fromQuery, syncUrl, toQuery } from '../../../src/dashboard/page/location';
import type { Store } from '../../../src/dashboard/page/store';
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

test('a view other than active follows the run or the queue, or stands alone, and active is left out (ADW-522)', () => {
  expect(toQuery(ui({ view: 'history' }))).toBe('view=history');
  expect(toQuery(ui({ repo: 'a', runId: 'r', view: 'history' }))).toBe('repo=a&run=r&view=history');
  expect(toQuery(ui({ queue: 'beta/t', view: 'queues' }))).toBe('queue=beta%2Ft&view=queues');
  expect(toQuery(ui({ repo: 'a', runId: 'r', view: 'active' }))).toBe('repo=a&run=r');
});

test('fromQuery reads a known view beside a run or a queue, and drops one that is none (ADW-522)', () => {
  expect(fromQuery(asked('repo=a&run=r&view=history')).view).toBe('history');
  expect(fromQuery(asked('queue=beta%2Ft&view=queues')).view).toBe('queues');
  expect(fromQuery(asked('view=nope'))).toEqual({ tab: 'overview', timeline: false });
});

test("toQuery writes the list's filters after the view, and none that is empty (ADW-546)", () => {
  expect(
    toQuery(
      ui({
        view: 'history',
        repoFilter: 'alpha',
        listFilter: 'fake',
        historyStatus: 'failed',
        historyWorkflow: 'ticket-to-pr',
      }),
    ),
  ).toBe('view=history&in=alpha&q=fake&status=failed&workflow=ticket-to-pr');
  expect(toQuery(ui({ repo: 'a', runId: 'r', view: 'history', repoFilter: 'beta' }))).toBe(
    'repo=a&run=r&view=history&in=beta',
  );
  expect(toQuery(ui({ listFilter: ' x ' }))).toBe('q=+x+');
  expect(toQuery(ui({ view: 'history', listFilter: '' }))).toBe('view=history');
  // Status and workflow belong to History alone.
  expect(toQuery(ui({ view: 'active', historyStatus: 'failed', historyWorkflow: 'w', repoFilter: 'alpha' }))).toBe(
    'in=alpha',
  );
});

test('fromQuery reads the filters, an unknown status and a status outside History ignored (ADW-546)', () => {
  const state = ui({
    view: 'history',
    repoFilter: 'alpha',
    listFilter: 'fake',
    historyStatus: 'failed',
    historyWorkflow: 'ticket-to-pr',
  });
  expect(fromQuery(asked(toQuery(state)))).toEqual({
    tab: 'overview',
    timeline: false,
    view: 'history',
    repoFilter: 'alpha',
    listFilter: 'fake',
    historyStatus: 'failed',
    historyWorkflow: 'ticket-to-pr',
  });
  expect(fromQuery(asked('repo=a&run=r&view=history&in=b&q=t&status=completed')).historyStatus).toBe('completed');
  expect(fromQuery(asked('queue=b%2Ft&view=queues&in=a&q=z'))).toEqual({
    queue: 'b/t',
    tab: 'overview',
    timeline: false,
    view: 'queues',
    repoFilter: 'a',
    listFilter: 'z',
  });
  expect(fromQuery(asked('view=history&status=bogus'))).toEqual({ tab: 'overview', timeline: false, view: 'history' });
  expect(fromQuery(asked('view=active&status=failed&workflow=w'))).toEqual({
    tab: 'overview',
    timeline: false,
    view: 'active',
  });
  expect(fromQuery(asked('status=failed&workflow=w'))).toEqual({ tab: 'overview', timeline: false });
  expect(fromQuery(asked('view=history&in=&q=&workflow='))).toEqual({
    tab: 'overview',
    timeline: false,
    view: 'history',
  });
});

test('syncUrl keeps the last query written when the host refuses a write, so the next sync tries it again (review R3)', () => {
  const writes: string[] = [];
  let takes = false;
  const store = {
    start: undefined,
    url: '',
    ui: ui({ listFilter: 'a' }),
    host: {
      setUrl: (query: string) => {
        writes.push(query);
        return takes;
      },
    },
  } as unknown as Store;
  syncUrl(store, false);
  expect(store.url).toBe('');
  takes = true;
  syncUrl(store, false);
  expect(store.url).toBe('q=a');
  expect(writes).toEqual(['q=a', 'q=a']);
});
