// The list's model: the Active, History and Queues views as grouped rows, the sidebar's counts and the cursor's entries.
import { expect, test } from 'bun:test';
import type { AttentionItem } from '../../../src/dashboard/page/attention';
import type { ListRepo, ListRun } from '../../../src/dashboard/page/index-model';
import {
  activeGroups,
  entries,
  filterRows,
  groupsOf,
  historyGroups,
  inboxGroups,
  queueGroups,
  repoDot,
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

test('historyGroups gives failed then completed runs, newest first, across repositories', () => {
  expect(ids(historyGroups([alpha, beta]))).toEqual([
    ['failed', ['run:beta/b-fail', 'run:alpha/a-fail']],
    ['done', ['run:beta/b-done', 'run:alpha/a-done']],
  ]);
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
  expect(ids(groupsOf('active', [alpha, beta], 'alpha'))).toEqual([
    ['waiting on you', ['run:alpha/a-run2']],
    ['running', ['run:alpha/a-run1']],
  ]);
  expect(viewCounts([alpha, beta])).toEqual({ inbox: 0, active: 6, queues: 0, history: 4 });
  expect(viewCounts([alpha, beta], 'alpha')).toEqual({ inbox: 0, active: 2, queues: 0, history: 2 });
  const q = repo('q', [], { workflows: [{ name: 'w', runs: [], queue: { waiting: 0 } }] });
  expect(viewCounts([q, alpha], 'q').queues).toBe(1);
  expect(groupsOf('queues', [q, alpha], 'q').map((g) => g.id)).toEqual(['queues:q']);
  expect(VIEWS).toEqual(['inbox', 'active', 'queues', 'history']);
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
  expect(ids(filterRows(historyGroups([alpha, beta]), 'stage_error'))).toEqual([['failed', ['run:alpha/a-fail']]]);
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

const items: AttentionItem[] = [
  {
    repo: 'alpha',
    runId: 'a-fail',
    kind: 'failed',
    title: 'failed: stage_error',
    detail: 'broke',
    opens: { repo: 'alpha', runId: 'a-fail' },
  },
  { repo: 'beta', runId: 'b-err', key: 'build#1', kind: 'error', title: 'build#1 ended in error', detail: 'oops' },
  {
    repo: 'alpha',
    workflow: 'flow',
    kind: 'parked',
    title: 'ticket:ADW-9 parked after 2 attempts',
    detail: 'no tests',
  },
  { repo: 'beta', kind: 'problem', title: 'repository', detail: 'cannot read' },
];

test('the Inbox lists one row per needs-attention item under the repository filter', () => {
  const rows = (filter?: string) =>
    groupsOf('inbox', [alpha, beta], filter, items).map((g) => [g.id, g.label, g.rows.map((r) => r.repo)]);
  expect(rows()).toEqual([
    ['inbox:runs', 'runs', ['alpha', 'beta']],
    ['inbox:parked', 'parked', ['alpha']],
    ['inbox:problems', 'problems', ['beta']],
  ]);
  expect(rows('alpha')).toEqual([
    ['inbox:runs', 'runs', ['alpha']],
    ['inbox:parked', 'parked', ['alpha']],
  ]);
  expect(viewCounts([alpha, beta], undefined, items).inbox).toBe(4);
  expect(viewCounts([alpha, beta], 'alpha', items).inbox).toBe(2);
  expect(groupsOf('inbox', [alpha, beta])).toEqual([]);
});

test('an Inbox row is known by inbox: and the item identity, and its text is searchable', () => {
  const groups = inboxGroups(items);
  const first = groups[0]?.rows[0];
  expect(first?.id).toBe(
    `inbox:${JSON.stringify(['alpha', 'failed', 'a-fail', null, null, 'failed: stage_error', 'broke'])}`,
  );
  const matches = (text: string) =>
    filterRows(groups, text).flatMap((g) => g.rows.map((r) => r.kind === 'attention' && r.item.title));
  expect(matches('OOPS')).toEqual(['build#1 ended in error']);
  expect(matches('flow')).toEqual(['ticket:ADW-9 parked after 2 attempts']);
  expect(matches('a-fail')).toEqual(['failed: stage_error']);
  expect(matches('build#1')).toEqual(['build#1 ended in error']);
});
