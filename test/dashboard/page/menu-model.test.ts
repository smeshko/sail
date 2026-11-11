// The command menu's rows: the subject's offered actions, "go to" by fuzzy match, the actions with no subject and the steps
// that ask an action's parameters. Pure, over made-up offers and a made-up index.
import { expect, test } from 'bun:test';
import type { RunActions } from '../../../src/dashboard/actions';
import type { IndexRepo } from '../../../src/dashboard/files';
import type { OfferSource, Subject } from '../../../src/dashboard/page/action-registry';
import {
  fuzzy,
  generalRows,
  gotoRows,
  headOf,
  type MenuRow,
  menuRows,
  stepOf,
  subjectRows,
} from '../../../src/dashboard/page/menu-model';
import type { MenuState } from '../../../src/dashboard/page/ui-state';

const on = { enabled: true };
const off = { enabled: false, why: 'no watcher is running' };
const RUN: Subject = { kind: 'run', repo: 'alpha', runId: 'FAKE-1-RUN' };
const ITEM: Subject = { kind: 'item', repo: 'beta', workflow: 'ticket-to-pr', item: 'ticket:FAKE-5' };
const QUEUE: Subject = { kind: 'workflow', repo: 'beta', workflow: 'ticket-to-pr' };

const runActions = {
  resume: { ...on, spentUsd: 2.5, budget: { maxUsd: 5 }, raise: 'usd' },
  restart: {
    ...on,
    stage: 'tests',
    stages: [
      { stage: 'spec', runsAgain: 'spec, tests' },
      { stage: 'tests', runsAgain: 'tests' },
    ],
    budget: { maxUsd: 10 },
  },
  stop: off,
  clean: { enabled: true, removes: ['its worktree'], archive: '/m/x' },
} as unknown as RunActions;

const item = (dedupKey: string, state: string, title: string) => ({ dedupKey, state, title, attempts: 0 });
const index = [
  {
    name: 'alpha',
    remote: null,
    runs: [{ runId: 'FAKE-1-RUN', summary: { ticket: { title: 'Fix the parser' }, totals: { usage: {} } } }],
    queues: [],
  },
  {
    name: 'beta',
    remote: null,
    runs: [],
    offers: { watch: on, unwatch: off, workflows: { 'ticket-to-pr': { watch: on, unwatch: off } } },
    queues: [
      {
        workflow: 'ticket-to-pr',
        watch: { state: 'watched' },
        offers: {
          poll: on,
          add: on,
          items: {
            'ticket:FAKE-5': { move: on, drop: on },
            'ticket:FAKE-6': { move: on, drop: off },
            'ticket:FAKE-7': { drop: on },
          },
        },
        queue: {
          polling: {},
          items: [
            item('ticket:FAKE-5', 'queued', 'Add a widget'),
            item('ticket:FAKE-6', 'queued', 'Tidy the docs'),
            item('ticket:FAKE-7', 'parked', 'Rotate the keys'),
          ],
        },
      },
    ],
  },
] as unknown as IndexRepo[];
const source = (run?: RunActions): OfferSource => ({ run, index });
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const state = (fields: Partial<MenuState> = {}): MenuState => ({
  mode: 'full',
  query: '',
  at: 0,
  steps: [],
  ...fields,
});
const labels = (rows: MenuRow[]) => rows.map((row) => row.label);

test('fuzzy matches a case-insensitive subsequence, scores a tighter match lower, and rejects the rest', () => {
  expect(fuzzy('REST', 'restart')).toBe(0);
  expect(fuzzy('rt', 'restart')).toBeGreaterThan(fuzzy('re', 'restart') ?? 99);
  expect(fuzzy('xr', 'restart')).toBeUndefined();
  expect(fuzzy('', 'anything')).toBe(0);
});

test('for a run subject the rows are exactly its offered actions: a disabled one with its reason, one not offered absent', () => {
  const rows = subjectRows(RUN, source(runActions));
  expect(rows.map((row) => [row.label, row.disabled, row.why])).toEqual([
    ['resume', false, undefined],
    ['restart', false, undefined],
    ['stop', true, 'no watcher is running'],
    ['stop now', true, 'no watcher is running'],
    ['clean', false, undefined],
  ]);
  expect(labels(subjectRows(RUN, source({ clean: on } as unknown as RunActions)))).toEqual(['clean']);
  expect(subjectRows(RUN, source(undefined))).toEqual([]);
});

test("an item's rows say a move as its own up and down rows, and a disabled drop carries its reason", () => {
  const rows = subjectRows({ ...ITEM, item: 'ticket:FAKE-6' }, source());
  expect(rows.map((row) => [row.label, row.disabled])).toEqual([
    ['drop', true],
    ['move up', false],
  ]);
  const up = rows[1]?.run;
  expect(up).toEqual({
    act: 'move-item',
    subject: { ...ITEM, item: 'ticket:FAKE-6' },
    data: { repo: 'beta', workflow: 'ticket-to-pr', item: 'ticket:FAKE-6', dir: 'up', target: 'ticket:FAKE-5' },
  });
});

test('with no subject there is no head and no subject row, and the general rows are there', () => {
  const model = menuRows(state(), source(), index, NOW);
  expect(model.head).toBeUndefined();
  expect(labels(model.rows)).toEqual([
    'all clear',
    'dismiss',
    'add a ticket…',
    'poll every queue',
    'switch theme',
    'toggle inspector',
  ]);
  expect(model.rows.every((row) => row.group === 'general')).toBe(true);
});

test('the head names the subject by its kind', () => {
  expect(headOf(RUN)).toBe('run FAKE-1-RUN');
  expect(headOf(ITEM)).toBe('item ticket:FAKE-5');
  expect(headOf(QUEUE)).toBe('workflow beta / ticket-to-pr');
  expect(headOf({ kind: 'repo', repo: 'beta' })).toBe('repository beta');
  expect(headOf({ kind: 'none' })).toBeUndefined();
  expect(headOf(undefined)).toBeUndefined();
});

test('adding and polling are left out where no queue offers them, and disabled with the reason where none is enabled', () => {
  expect(labels(generalRows({ index: [] }))).toEqual(['all clear', 'dismiss', 'switch theme', 'toggle inspector']);
  const closed = JSON.parse(JSON.stringify(index)) as IndexRepo[];
  const queue = closed[1]?.queues[0] as unknown as { offers: { poll: unknown; add: unknown } };
  queue.offers.poll = off;
  queue.offers.add = off;
  const rows = generalRows({ index: closed });
  expect(rows.filter((row) => row.disabled).map((row) => [row.label, row.why])).toEqual([
    ['add a ticket…', 'no watcher is running'],
    ['poll every queue', 'no watcher is running'],
  ]);
});

test('a query lists go-to rows for a run id, a run title, a queue, an item key, an item title and a repository', () => {
  const goto = (query: string) => gotoRows(query, index, NOW).map((row) => [row.hint, row.label]);
  expect(goto('fake-1-r')).toEqual([['run', 'FAKE-1-RUN']]);
  expect(goto('parser')).toEqual([['run', 'FAKE-1-RUN']]);
  expect(goto('ticket-to')).toEqual([['queue', 'beta / ticket-to-pr']]);
  expect(goto('FAKE-5')).toEqual([['item', 'ticket:FAKE-5']]);
  expect(goto('widget')).toEqual([['item', 'ticket:FAKE-5']]);
  expect(goto('alph')).toEqual([['repository', 'alpha']]);
  expect(gotoRows('', index, NOW)).toEqual([]);
  expect(gotoRows('zzzz', index, NOW)).toEqual([]);
});

test('a go-to row for an item goes to the item, and only the eight best are listed', () => {
  expect(gotoRows('ticket:FAKE-5', index, NOW)[0]?.run).toEqual({ goto: ITEM });
  const many = [
    {
      name: 'alpha',
      remote: null,
      runs: Array.from({ length: 12 }, (_, at) => ({ runId: `FAKE-${at}-R`, summary: { totals: { usage: {} } } })),
      queues: [],
    },
  ] as unknown as IndexRepo[];
  expect(gotoRows('fake', many, NOW)).toHaveLength(8);
});

test('a query filters the subject and general groups by label and lists go-to rows between them', () => {
  const model = menuRows(state({ subject: RUN, query: 'rest' }), source(runActions), index, NOW);
  expect(model.rows.map((row) => [row.group, row.label])).toEqual([['subject', 'restart']]);
  const both = menuRows(state({ subject: RUN, query: 'fake-1' }), source(runActions), index, NOW);
  expect(both.rows.map((row) => row.group)).toEqual(['goto']);
});

test('context mode gives the subject group alone, whatever is typed', () => {
  const model = menuRows(state({ mode: 'context', subject: ITEM, query: 'zzz' }), source(), index, NOW);
  expect(model.head).toBe('FAKE-5 · Add a widget');
  expect(labels(model.rows)).toEqual(['drop', 'move down']);
});

const step = (action: string, subject: Subject, at: number, values: Record<string, string> = {}) =>
  ({ action, subject, data: {}, values, at }) as const;

test('a restart step lists the offered stages with what they run again as hints, starting on the offered stage', () => {
  const model = stepOf(step('restart-run', RUN, 0), source(runActions));
  expect(model.label).toBe('from');
  expect(model.rows.map((row) => [row.label, row.hint])).toEqual([
    ['spec', 'spec, tests'],
    ['tests', 'tests'],
  ]);
  expect(model.start).toBe(1);
  expect(model.rows[0]?.run).toEqual({ value: 'spec' });
  expect(model.lines).toContain('runs again: tests');
});

test('a resume step is a number field that shows what was spent, and the raise as it is typed', () => {
  const none = stepOf(step('resume-run', RUN, 0), source(runActions));
  expect(none.field).toEqual({ type: 'number', min: 0.01 });
  expect(none.label).toBe('raise $');
  expect(none.lines).toEqual(['spent $2.50 of $5.00']);
  expect(stepOf(step('resume-run', RUN, 0), source(runActions), '2').lines).toEqual([
    'spent $2.50 of $5.00',
    'raises the budget by $2.00',
  ]);
});

test('an add step asks the ticket key as a text field, and asks nothing after it', () => {
  const key = stepOf(step('add-ticket', QUEUE, 0), source());
  expect(key.label).toBe('ticket key');
  expect(key.field).toEqual({ type: 'text', placeholder: 'ticket key' });
  expect(stepOf(step('add-ticket', QUEUE, 1, { ticket: 'FAKE-9' }), source()).rows).toEqual([]);
});

test('the queue step lists each queue that offers the action, and a step with no such parameter is empty', () => {
  const model = stepOf({ pick: 'queue', action: 'add-ticket' }, source());
  expect(model.rows.map((row) => [row.label, row.run])).toEqual([
    ['beta / ticket-to-pr', { queue: { repo: 'beta', workflow: 'ticket-to-pr' } }],
  ]);
  expect(stepOf(step('stop-run', RUN, 5), source(runActions)).rows).toEqual([]);
});

test('while a step is open the menu is its rows under the subject head, and nothing else', () => {
  const model = menuRows(state({ subject: RUN, steps: [step('restart-run', RUN, 0)] }), source(runActions), index, NOW);
  expect(model.head).toBe('run FAKE-1-RUN');
  expect(labels(model.rows)).toEqual(['spec', 'tests']);
  expect(model.step?.label).toBe('from');
});

test('a workflow offers release only while its queue is held on a harness key, and the row carries that key', () => {
  expect(labels(subjectRows(QUEUE, source())).includes('release')).toBe(false);
  const held = structuredClone(index) as unknown as {
    queues: { queue: { held?: { harnessKey?: string } } }[];
  }[];
  const queue = held[1]?.queues[0]?.queue;
  if (queue === undefined) throw new Error('no queue');
  queue.held = {};
  expect(labels(subjectRows(QUEUE, { index: held as unknown as IndexRepo[] })).includes('release')).toBe(false);
  queue.held = { harnessKey: 'claude-code' };
  const release = subjectRows(QUEUE, { index: held as unknown as IndexRepo[] }).find((row) => row.label === 'release');
  expect(release?.run).toEqual({
    act: 'release-hold',
    subject: QUEUE,
    data: { repo: 'beta', workflow: 'ticket-to-pr', harness: 'claude-code' },
  });
  expect(release?.disabled).toBe(false);
});

// Start a run (ADW-524): its row on a repository and a queue, in the general group, its steps, and start anyway.
const START = { enabled: true, workflows: ['review', 'ticket-to-pr'], defaultWorkflow: 'ticket-to-pr' };
const startIndex = [
  { name: 'alpha', remote: null, runs: [], queues: [], offers: { watch: on, workflows: {}, start: START } },
  {
    name: 'beta',
    remote: null,
    runs: [],
    offers: { watch: on, workflows: {}, start: { enabled: false, why: '/b/.sail no longer exists', workflows: [] } },
    queues: [{ workflow: 'ticket-to-pr', watch: { state: 'watched' }, offers: { poll: on, add: on, items: {} } }],
  },
  { name: 'gamma', remote: null, runs: [], queues: [], offers: { watch: on, workflows: {} } },
] as unknown as IndexRepo[];
const startSource = (extra: Partial<OfferSource> = {}): OfferSource => ({ index: startIndex, ...extra });

test('a repository subject has the row start a run…, and so has a queue’s workflow, each running the action on its subject', () => {
  const alpha: Subject = { kind: 'repo', repo: 'alpha' };
  const rows = subjectRows(alpha, startSource()).filter((row) => row.label === 'start a run…');
  expect(rows.map((row) => [row.disabled, row.run])).toEqual([
    [false, { act: 'start-run', subject: alpha, data: { repo: 'alpha' } }],
  ]);
  const beta: Subject = { kind: 'workflow', repo: 'beta', workflow: 'ticket-to-pr' };
  expect(subjectRows(beta, startSource()).map((row) => [row.label, row.disabled, row.why])).toContainEqual([
    'start a run…',
    true,
    '/b/.sail no longer exists',
  ]);
  expect(labels(subjectRows({ kind: 'repo', repo: 'gamma' }, startSource()))).not.toContain('start a run…');
});

test('the general group has start a run… as a repository pick, and none when no repository offers it', () => {
  const row = generalRows(startSource()).find((each) => each.label === 'start a run…');
  expect([row?.group, row?.disabled, row?.run]).toEqual(['general', false, { pick: 'start-run', of: 'repo' }]);
  expect(labels(generalRows(source()))).not.toContain('start a run…');
  const gone = generalRows({ index: [startIndex[1] as IndexRepo] }).find((each) => each.label === 'start a run…');
  expect([gone?.disabled, gone?.why]).toEqual([true, '/b/.sail no longer exists']);
});

test('the repository step lists each repository that offers the start, a disabled one with its reason, starting on the first enabled', () => {
  const model = stepOf({ pick: 'repo', action: 'start-run' }, startSource());
  expect(model.label).toBe('repository');
  expect(model.rows.map((row) => [row.label, row.disabled, row.why, row.run])).toEqual([
    ['alpha', false, undefined, { repo: 'alpha' }],
    ['beta', true, '/b/.sail no longer exists', { repo: 'beta' }],
  ]);
  expect(model.start).toBe(0);
});

test('the start steps ask the workflow, on the default, then the ticket key or pull request, then the stage to stop after', () => {
  const alpha: Subject = { kind: 'repo', repo: 'alpha' };
  const step = (at: number) =>
    stepOf({ action: 'start-run', subject: alpha, data: { repo: 'alpha' }, values: {}, at }, startSource());
  const workflow = step(0);
  expect([workflow.label, workflow.rows.map((row) => row.label), workflow.start]).toEqual([
    'workflow',
    ['review', 'ticket-to-pr'],
    1,
  ]);
  expect([step(1).label, step(1).field]).toEqual(['ticket key or pull request', { type: 'text' }]);
  expect([step(2).label, step(2).field]).toEqual(['stop after', { type: 'text' }]);
  const queue: Subject = { kind: 'workflow', repo: 'alpha', workflow: 'ticket-to-pr' };
  const first = stepOf({ action: 'start-run', subject: queue, data: {}, values: {}, at: 0 }, startSource());
  expect(first.label).toBe('ticket key or pull request');
});

test('start anyway is a general row naming the ticket and the flag only after a refusal that offers it, running the action with the refused start', () => {
  const refused = { repo: 'alpha', source: 'FAKE-3', workflow: 'ticket-to-pr', override: 'force' } as const;
  const row = generalRows(startSource({ start: refused })).find((each) => each.label.startsWith('start FAKE-3'));
  expect([row?.label, row?.disabled, row?.run]).toEqual([
    'start FAKE-3 anyway (--force)',
    false,
    {
      act: 'start-run-force',
      subject: { kind: 'none' },
      data: { repo: 'alpha', source: 'FAKE-3', workflow: 'ticket-to-pr', force: 'true' },
    },
  ]);
  expect(labels(generalRows(startSource()))).not.toContain('start FAKE-3 anyway (--force)');
  expect(labels(generalRows(startSource({ start: { ...refused, override: 'ignore-prerequisites' } })))).toContain(
    'start FAKE-3 anyway (--ignore-prerequisites)',
  );
});
