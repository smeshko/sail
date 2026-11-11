// Which row the centre shows unasked: the first row of a view that opens something, a folded group's rows and an Inbox
// problem row skipped, an empty view closing what is open, and a narrow window selecting nothing.
import { describe, expect, test } from 'bun:test';
import type { IndexRepo } from '../../../src/dashboard/files';
import type { PageHost } from '../../../src/dashboard/page/host';
import { cursorToOpen, keepSelection, selectFirst, shownRows } from '../../../src/dashboard/page/selection';
import { createStore, type Store } from '../../../src/dashboard/page/store';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const runOf = (runId: string, status: string, startedAt: string) => ({
  runId,
  status: { status },
  startedAt,
  workflow: 'flow@1',
});

/** A host that holds nothing and answers nothing: enough to open a run and its (silent) socket. */
function store(index: unknown[], narrow = false): { store: Store; connects: string[] } {
  const connects: string[] = [];
  const host = {
    load: () => undefined,
    save: () => {},
    setTheme: () => {},
    offset: () => 0,
    start: () => ({}),
    now: () => NOW,
    later: () => 0,
    cancel: () => {},
    narrow: () => narrow,
    connect: (query: string) => {
      connects.push(query);
      return { close: () => {} };
    },
    get: () => new Promise(() => {}),
  } as unknown as PageHost;
  const made = createStore(host);
  made.start = undefined;
  made.index = index as IndexRepo[];
  return { store: made, connects };
}

const repo = (name: string, runs: unknown[], extra: Record<string, unknown> = {}) => ({
  name,
  remote: null,
  runs,
  queues: [],
  ...extra,
});

const live = [
  repo('alpha', [
    runOf('a-old', 'running', '2026-10-01T08:00:00Z'),
    runOf('a-new', 'running', '2026-10-01T10:00:00Z'),
    runOf('a-done', 'completed', '2026-10-01T07:00:00Z'),
  ]),
];

describe('audit 2: rows say what they are (ADW-543)', () => {
  test("the row a view opens with takes the list's cursor, and so does the first row when it was open already", () => {
    const { store: made } = store(live);
    made.ui.view = 'active';
    selectFirst(made);
    expect(made.ui.listCursor).toBe('run:alpha/a-new');
    delete made.ui.listCursor;
    selectFirst(made);
    expect([made.ui.runId, made.ui.listCursor]).toEqual(['a-new', 'run:alpha/a-new']);
  });

  test('cursorToOpen keeps the cursor on an open row it is on, else moves it to the open row the list shows', () => {
    const { store: made } = store(live);
    made.ui.view = 'active';
    selectFirst(made);
    made.ui.listCursor = 'run:alpha/a-old';
    cursorToOpen(made);
    expect(made.ui.listCursor).toBe('run:alpha/a-new');
    cursorToOpen(made);
    expect(made.ui.listCursor).toBe('run:alpha/a-new');
  });
});

test('Active opens its newest running run, as a click on its first row does', () => {
  const { store: made, connects } = store(live);
  made.ui.view = 'active';
  selectFirst(made);
  expect([made.ui.repo, made.ui.runId]).toEqual(['alpha', 'a-new']);
  expect(connects).toEqual(['run=alpha%2Fa-new']);
});

test('History opens its newest finished run', () => {
  const { store: made } = store(live);
  made.ui.view = 'history';
  selectFirst(made);
  expect(made.ui.runId).toBe('a-done');
});

test('a folded group is skipped: the first row is the first of a group that is open', () => {
  const { store: made } = store(live);
  made.ui.view = 'active';
  made.ui.listFolded = ['active:running'];
  expect(shownRows(made, false)).toEqual([]);
  expect(shownRows(made, true).map((row) => row.id)).toEqual(['run:alpha/a-new', 'run:alpha/a-old']);
  selectFirst(made);
  expect(made.ui.runId).toBeUndefined();
});

test('an Inbox row that opens nothing is skipped: the problem row gives way to the run row under it', () => {
  const broken = repo('beta', [], { problem: 'cannot read' });
  const failing = repo('alpha', [runOf('a-fail', 'failed', '2026-10-01T07:00:00Z')]);
  const { store: made } = store([broken, failing]);
  made.ui.view = 'inbox';
  expect(shownRows(made, false).map((row) => row.id)[0]).toMatch(/^inbox:/);
  selectFirst(made);
  expect([made.ui.repo, made.ui.runId]).toEqual(['alpha', 'a-fail']);
});

test('a view with no row that opens anything closes the open run', () => {
  const { store: made } = store(live);
  made.ui.view = 'active';
  selectFirst(made);
  expect(made.ui.runId).toBe('a-new');
  made.ui.view = 'inbox';
  selectFirst(made);
  expect(made.ui.runId).toBeUndefined();
  expect(made.run).toBeUndefined();
});

test('the first row already open is left alone', () => {
  const { store: made, connects } = store(live);
  made.ui.view = 'active';
  selectFirst(made);
  selectFirst(made);
  expect(connects).toEqual(['run=alpha%2Fa-new']);
});

test('a narrow window selects nothing', () => {
  const { store: made, connects } = store(live, true);
  made.ui.view = 'active';
  selectFirst(made);
  expect(made.ui.runId).toBeUndefined();
  expect(connects).toEqual([]);
});

const filtered = (made: Store, text: string) => () => {
  made.ui.listFilter = text;
};

test('keepSelection keeps the open row when the change leaves it listed', () => {
  const { store: made, connects } = store(live);
  made.ui.view = 'active';
  selectFirst(made);
  keepSelection(made, filtered(made, 'a-new'));
  expect(made.ui.runId).toBe('a-new');
  expect(connects).toEqual(['run=alpha%2Fa-new']);
});

test('keepSelection opens the first row left when the change drops the open row', () => {
  const { store: made } = store(live);
  made.ui.view = 'active';
  selectFirst(made);
  keepSelection(made, filtered(made, 'a-old'));
  expect(made.ui.runId).toBe('a-old');
});

test('keepSelection closes the open run when the change leaves no row, and opens the first row once rows return', () => {
  const { store: made } = store(live);
  made.ui.view = 'active';
  selectFirst(made);
  keepSelection(made, filtered(made, 'nothing'));
  expect(made.ui.runId).toBeUndefined();
  keepSelection(made, filtered(made, ''));
  expect(made.ui.runId).toBe('a-new');
});

test('keepSelection selects nothing after a person closed the centre', () => {
  const { store: made } = store(live);
  made.ui.view = 'active';
  made.deselected = true;
  keepSelection(made, filtered(made, 'a-old'));
  expect(made.ui.runId).toBeUndefined();
});

test('keepSelection leaves a run the list never showed open', () => {
  const { store: made } = store(live);
  made.ui.view = 'active';
  selectFirst(made);
  made.ui.view = 'history';
  keepSelection(made, filtered(made, 'a-done'));
  expect(made.ui.runId).toBe('a-new');
});

test('keepSelection only applies the change in a narrow window', () => {
  const { store: made, connects } = store(live, true);
  made.ui.view = 'active';
  keepSelection(made, filtered(made, 'a-old'));
  expect(made.ui.listFilter).toBe('a-old');
  expect(connects).toEqual([]);
});
