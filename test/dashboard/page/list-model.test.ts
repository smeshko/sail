// The list's model: the Active, History and Queues views as grouped rows, the sidebar's counts and the cursor's entries.
import { expect, test } from 'bun:test';
import type { ListRepo, ListRun } from '../../../src/dashboard/page/index-model';
import {
  activeGroups,
  entries,
  filterHistory,
  filterRows,
  groupsOf,
  historyGroups,
  historyWorkflows,
  queueGroups,
  repoDot,
  selectedRows,
  shownGroups,
  VIEWS,
  viewCounts,
  waitsOnPerson,
} from '../../../src/dashboard/page/list-model';

const run = (runId: string, status: string, startedAt: string, extra: Partial<ListRun> = {}): ListRun => ({
  runId,
  status,
  startedAt,
  workflow: 'flow@1',
  ...extra,
});

const repo = (name: string, runs: ListRun[], extra: Partial<ListRepo> = {}): ListRepo => ({
  name,
  remote: null,
  live: false,
  runs,
  workflows: [],
  ...extra,
});

const alpha = repo('alpha', [
  run('a-run1', 'running', '2026-10-01T10:00:00Z', { title: 'Fix the Parser' }),
  run('a-run2', 'suspended', '2026-10-01T09:00:00Z', { ticketKey: 'ADW-2' }),
  run('a-fail', 'failed', '2026-10-01T08:00:00Z', { stopReason: 'stage_error' }),
  run('a-done', 'completed', '2026-10-01T07:00:00Z'),
]);
const beta = repo('beta', [
  run('b-run1', 'running', '2026-10-01T11:00:00Z'),
  run('b-run2', 'running', '2026-10-01T08:30:00Z'),
  run('b-bad', 'unknown', '2026-10-01T06:00:00Z', { problem: 'run.json is not a run header' }),
  run('b-susp', 'suspended', '2026-10-01T10:30:00Z'),
  run('b-fail', 'failed', '2026-10-01T09:30:00Z'),
  run('b-done', 'completed', '2026-10-01T12:00:00Z'),
]);
const CLOCK = { now: Date.parse('2026-10-01T12:00:00Z'), tz: 0 };
const ids = (groups: ReturnType<typeof activeGroups>) => groups.map((g) => [g.label, g.rows.map((r) => r.id)]);

test('activeGroups puts waiting-on-you runs first and running ones after, each newest first, and leaves finished runs out', () => {
  expect(ids(activeGroups([alpha, beta]))).toEqual([
    ['waiting on you', ['run:beta/b-susp', 'run:alpha/a-run2', 'run:beta/b-bad']],
    ['running', ['run:beta/b-run1', 'run:alpha/a-run1', 'run:beta/b-run2']],
  ]);
});

test('activeGroups leaves out an empty group', () => {
  expect(ids(activeGroups([repo('x', [run('x1', 'running', '2026-10-01T10:00:00Z')])]))).toEqual([
    ['running', ['run:x/x1']],
  ]);
  expect(activeGroups([repo('x', [run('x1', 'failed', '2026-10-01T10:00:00Z')])])).toEqual([]);
});

test('waitsOnPerson is true for a live run that is not running', () => {
  expect(
    ['running', 'suspended', 'blocked', 'unknown', 'failed', 'completed'].map((s) => waitsOnPerson(run('r', s, 'x'))),
  ).toEqual([false, true, true, true, false, false]);
});

test('historyGroups groups finished runs by start day, Today and Yesterday first, newest first across statuses', () => {
  const one = repo('one', [
    run('o-old', 'failed', '2026-09-20T10:00:00Z'),
    run('o-today', 'completed', '2026-10-01T09:00:00Z'),
    run('o-live', 'running', '2026-10-01T10:00:00Z'),
  ]);
  const two = repo('two', [
    run('t-yday', 'failed', '2026-09-30T08:00:00Z'),
    run('t-today', 'failed', '2026-10-01T11:00:00Z'),
    run('t-yday2', 'completed', '2026-09-30T23:00:00Z'),
  ]);
  const groups = historyGroups([one, two], CLOCK);
  expect(groups.map((g) => g.id)).toEqual(['history:2026-10-01', 'history:2026-09-30', 'history:2026-09-20']);
  expect(ids(groups)).toEqual([
    ['Today', ['run:two/t-today', 'run:one/o-today']],
    ['Yesterday', ['run:two/t-yday2', 'run:two/t-yday']],
    ['2026-09-20', ['run:one/o-old']],
  ]);
});

test("historyGroups takes the day at the clock's offset", () => {
  const late = repo('late', [run('l1', 'failed', '2026-10-01T23:30:00Z')]);
  expect(ids(historyGroups([late], CLOCK))).toEqual([['Today', ['run:late/l1']]]);
  const ahead = historyGroups([late], { now: CLOCK.now, tz: 60 });
  expect(ahead.map((g) => [g.id, g.label])).toEqual([['history:2026-10-02', '2026-10-02']]);
  expect(historyGroups([late], { now: Date.parse('2026-10-01T23:30:00Z'), tz: 60 })[0]?.label).toBe('Today');
});

test('historyGroups puts a run with no start time in a last group', () => {
  const r = repo('x', [
    { runId: 'x-none', status: 'failed', workflow: 'flow@1' },
    run('x-bad', 'completed', 'not a time'),
    run('x-ok', 'completed', '2026-10-01T09:00:00Z'),
  ]);
  const groups = historyGroups([r], CLOCK);
  expect(groups.map((g) => [g.id, g.label])).toEqual([
    ['history:2026-10-01', 'Today'],
    ['history:undated', 'no start time'],
  ]);
  expect(groups[1]?.rows.map((row) => row.id).sort()).toEqual(['run:x/x-bad', 'run:x/x-none']);
});

test('queueGroups gives a group for every repository, with a row per queue and none for a workflow without one', () => {
  const withQueues = repo('alpha', [], {
    workflows: [
      { name: 'one', runs: [], queue: { waiting: 2, lastPolledAt: '2026-10-01T10:00:00Z' } },
      { name: 'two', runs: [] },
    ],
  });
  const groups = queueGroups([withQueues, beta]);
  expect(groups.map((g) => [g.id, g.label, g.repo?.name, g.rows.map((r) => r.id)])).toEqual([
    ['queues:alpha', 'alpha', 'alpha', ['queue:alpha/one']],
    ['queues:beta', 'beta', 'beta', []],
  ]);
  expect(groups[0]?.rows[0]).toMatchObject({ kind: 'queue', waiting: 2, lastPolledAt: '2026-10-01T10:00:00Z' });
});

test('groupsOf with a repository filter keeps only that repository, and viewCounts counts the same rows', () => {
  expect(ids(groupsOf('active', [alpha, beta], 'alpha', CLOCK))).toEqual([
    ['waiting on you', ['run:alpha/a-run2']],
    ['running', ['run:alpha/a-run1']],
  ]);
  expect(viewCounts([alpha, beta])).toEqual({ active: 6, queues: 0, history: 4 });
  expect(viewCounts([alpha, beta], 'alpha')).toEqual({ active: 2, queues: 0, history: 2 });
  const q = repo('q', [], { workflows: [{ name: 'w', runs: [], queue: { waiting: 0 } }] });
  expect(viewCounts([q, alpha], 'q').queues).toBe(1);
  expect(groupsOf('queues', [q, alpha], 'q', CLOCK).map((g) => g.id)).toEqual(['queues:q']);
  expect(VIEWS).toEqual(['active', 'queues', 'history']);
});

test('repoDot gives broken, watching and idle', () => {
  expect(repoDot(repo('a', [], { problem: 'cannot read' }))).toBe('broken');
  expect(repoDot(repo('a', [], { problem: 'cannot read', watching: ['w'] }))).toBe('broken');
  expect(repoDot(repo('a', [], { watching: ['w'] }))).toBe('watching');
  expect(repoDot(repo('a', [], { watching: [] }))).toBe('idle');
  expect(repoDot(repo('a', []))).toBe('idle');
});

test('filterRows matches a title fragment in any case and drops a group left empty', () => {
  const groups = activeGroups([alpha, beta]);
  expect(ids(filterRows(groups, 'PARSER'))).toEqual([['running', ['run:alpha/a-run1']]]);
  expect(ids(filterRows(groups, 'adw-2'))).toEqual([['waiting on you', ['run:alpha/a-run2']]]);
  expect(ids(filterRows(groups, 'zzz'))).toEqual([]);
  expect(filterRows(groups, '  ')).toEqual(groups);
  expect(ids(filterRows(historyGroups([alpha, beta], CLOCK), 'stage_error'))).toEqual([
    ['Today', ['run:alpha/a-fail']],
  ]);
  expect(ids(filterRows(activeGroups([alpha, beta]), 'beta'))).toEqual([
    ['waiting on you', ['run:beta/b-susp', 'run:beta/b-bad']],
    ['running', ['run:beta/b-run1', 'run:beta/b-run2']],
  ]);
});

test('entries lists group ids and visible row ids in order, leaving out the rows of a folded group', () => {
  const groups = activeGroups([alpha, beta]);
  expect(entries(groups, [])).toEqual([
    'active:waiting',
    'run:beta/b-susp',
    'run:alpha/a-run2',
    'run:beta/b-bad',
    'active:running',
    'run:beta/b-run1',
    'run:alpha/a-run1',
    'run:beta/b-run2',
  ]);
  expect(entries(groups, ['active:waiting'])).toEqual([
    'active:waiting',
    'active:running',
    'run:beta/b-run1',
    'run:alpha/a-run1',
    'run:beta/b-run2',
  ]);
});

const mixed = [
  repo('alpha', [
    run('a1', 'failed', '2026-10-01T09:00:00Z', { workflow: 'ticket-to-pr@3' }),
    run('a2', 'completed', '2026-10-01T08:00:00Z', { workflow: 'ticket-to-pr@3' }),
    run('a3', 'completed', '2026-09-30T08:00:00Z', { workflow: 'review@1' }),
  ]),
  repo('beta', [run('b1', 'failed', '2026-09-29T08:00:00Z', { workflow: 'review@1' })]),
];

test('filterHistory keeps the rows of a status and of a workflow and drops a day left empty', () => {
  const groups = historyGroups(mixed, CLOCK);
  expect(ids(filterHistory(groups, { status: 'failed' }))).toEqual([
    ['Today', ['run:alpha/a1']],
    ['2026-09-29', ['run:beta/b1']],
  ]);
  expect(ids(filterHistory(groups, { workflow: 'ticket-to-pr' }))).toEqual([
    ['Today', ['run:alpha/a1', 'run:alpha/a2']],
  ]);
  expect(ids(filterHistory(groups, { status: 'completed', workflow: 'review' }))).toEqual([
    ['Yesterday', ['run:alpha/a3']],
  ]);
  expect(ids(filterHistory(groups, {}))).toEqual(ids(groups));
});

test('historyWorkflows lists the distinct workflows of the finished runs, sorted, under the repository filter', () => {
  const live = repo('gamma', [run('g1', 'running', '2026-10-01T09:00:00Z', { workflow: 'zzz@1' })]);
  expect(historyWorkflows([...mixed, live])).toEqual(['review', 'ticket-to-pr']);
  expect(historyWorkflows(mixed, 'beta')).toEqual(['review']);
});

test('shownGroups combines the repository, status, workflow and text filters in History only', () => {
  const filters = { listFilter: '', tz: 0 };
  const flat = (groups: ReturnType<typeof shownGroups>) => groups.flatMap((g) => g.rows.map((r) => r.id));
  expect(flat(shownGroups('history', mixed, { ...filters, historyStatus: 'failed' }, CLOCK.now))).toEqual([
    'run:alpha/a1',
    'run:beta/b1',
  ]);
  expect(
    flat(shownGroups('history', mixed, { ...filters, historyStatus: 'failed', historyWorkflow: 'review' }, CLOCK.now)),
  ).toEqual(['run:beta/b1']);
  expect(
    flat(shownGroups('history', mixed, { ...filters, historyStatus: 'failed', repoFilter: 'alpha' }, CLOCK.now)),
  ).toEqual(['run:alpha/a1']);
  expect(
    flat(shownGroups('history', mixed, { ...filters, listFilter: 'a3', historyStatus: 'failed' }, CLOCK.now)),
  ).toEqual([]);
  expect(flat(shownGroups('active', mixed, { ...filters, historyStatus: 'failed' }, CLOCK.now))).toEqual([]);
});

test('selectedRows gives the run rows of the groups whose id is selected, in list order', () => {
  const groups = historyGroups(mixed, CLOCK);
  expect(
    selectedRows(groups, ['run:beta/b1', 'run:alpha/a1', 'run:gone/x', 'history:2026-10-01']).map((row) => row.id),
  ).toEqual(['run:alpha/a1', 'run:beta/b1']);
  expect(selectedRows(groups, [])).toEqual([]);
  expect(
    selectedRows(filterHistory(groups, { status: 'completed' }), ['run:alpha/a1', 'run:alpha/a2']).map((r) => r.id),
  ).toEqual(['run:alpha/a2']);
});
