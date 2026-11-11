// The command menu's rows: the subject's offered actions, "go to" by fuzzy match, the actions with no subject and the steps
// that ask an action's parameters. Pure, over made-up offers and a made-up index.
import { describe, expect, test } from 'bun:test';
import type { RunActions } from '../../../src/dashboard/actions';
import type { IndexRepo } from '../../../src/dashboard/files';
import type { OfferSource, Subject } from '../../../src/dashboard/page/action-registry';
import { listRepos } from '../../../src/dashboard/page/index-model';
import {
  fuzzy,
  generalRows,
  gotoRows,
  headOf,
  type MenuRow,
  menuRows,
  rank,
  sharedWhy,
  stepOf,
  subjectRows,
  wordFuzzy,
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
const runIds = (rows: MenuRow[]) =>
  rows.map((row) => ('goto' in row.run && row.run.goto.kind === 'run' ? row.run.goto.runId : row.hint));

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
    ['move to the top', false],
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
    'Inbox',
    'Active',
    'Queues',
    'History',
    'add a ticket…',
    'poll every queue',
    'switch theme',
    'toggle inspector',
  ]);
  expect(model.rows.map((row) => row.group)).toEqual([...Array(4).fill('goto'), ...Array(4).fill('general')]);
});

test('the head names the subject as the list does, with no word for its kind', () => {
  expect(headOf(RUN)).toBe('FAKE-1-RUN');
  expect(headOf(ITEM)).toBe('FAKE-5');
  expect(headOf(QUEUE)).toBe('beta › ticket-to-pr');
  expect(headOf({ kind: 'repo', repo: 'beta' })).toBe('beta');
  expect(headOf({ kind: 'none' })).toBeUndefined();
  expect(headOf(undefined)).toBeUndefined();
});

test('adding and polling are left out where no queue offers them, and disabled with the reason where none is enabled', () => {
  expect(labels(generalRows({ index: [] }))).toEqual(['switch theme', 'toggle inspector']);
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
  expect(goto('fake-1-r')).toEqual([['alpha › unknown', 'Fix the parser']]);
  expect(goto('parser')).toEqual([['alpha › unknown', 'Fix the parser']]);
  expect(goto('ticket-to')).toEqual([['queue', 'beta › ticket-to-pr']]);
  expect(goto('FAKE-5')).toEqual([['beta › ticket-to-pr', 'Add a widget']]);
  expect(goto('widget')).toEqual([['beta › ticket-to-pr', 'Add a widget']]);
  expect(goto('alph')).toEqual([
    ['repository', 'alpha'],
    ['alpha › unknown', 'Fix the parser'],
  ]);
  expect(gotoRows('zzzz', index, NOW)).toEqual([]);
});

const ticketRun = (runId: string, key: string, title: string) => ({
  runId,
  source: { kind: 'ticket', ticketKey: key },
  summary: { ticket: { title }, totals: { usage: {} } },
});
const runsIndex = (runs: unknown[]) => [{ name: 'alpha', remote: null, runs, queues: [] }] as unknown as IndexRepo[];

describe('audit 2: the menu ranks across groups, matches within words and says a reason once (ADW-544)', () => {
  const liveRun = (runId: string, key: string, title: string, status = 'running') => ({
    ...ticketRun(runId, key, title),
    status: { status },
  });
  const queueOf = (workflow: string, items: unknown[], offers: unknown = { poll: on, add: on, items: {} }) => ({
    workflow,
    watch: { state: 'watched' },
    offers,
    queue: { polling: {}, items },
  });
  const START_ON = { enabled: true, workflows: ['ticket-to-pr'], defaultWorkflow: 'ticket-to-pr' };
  const machine = [
    {
      name: 'alpha',
      remote: null,
      runs: [
        liveRun('A-LIVE', 'LIFE-204', 'Start the parser'),
        liveRun('A-DONE', 'LIFE-200', 'Finished earlier', 'completed'),
        liveRun('A-ADD', 'FAKE-12', 'Add a --shout flag'),
      ],
      offers: { watch: on, workflows: {}, start: START_ON },
      queues: [queueOf('ticket-to-pr', [item('ticket:FAKE-100', 'queued', 'Both queues')])],
    },
    {
      name: 'beta',
      remote: null,
      runs: [liveRun('B-1', 'FAKE-13', 'Add log phrase handling')],
      offers: { watch: on, workflows: {}, start: { enabled: true, workflows: [] } },
      queues: [queueOf('review', [item('ticket:FAKE-100', 'parked', 'Both queues')])],
    },
  ] as unknown as IndexRepo[];
  const full = (query: string, subject?: Subject, extra: Partial<OfferSource> = {}) =>
    menuRows(
      state({ query, ...(subject === undefined ? {} : { subject }) }),
      { index: machine, ...extra },
      machine,
      NOW,
    ).rows;
  const groups = (rows: MenuRow[]) => rows.map((row) => row.group).filter((group, at, all) => all[at - 1] !== group);

  test('an action a query starts, or starts a word of, comes before every go-to row', () => {
    const start = full('start');
    expect(start[0]).toMatchObject({ group: 'general', label: 'start a run…' });
    expect(start.findIndex((row) => row.lead === 'LIFE-204')).toBeGreaterThan(0);
    const add = full('add');
    expect(add[0]).toMatchObject({ group: 'general', label: 'add a ticket…' });
    expect(groups(add)).toEqual(['general', 'goto']);
    // A word inside the label counts too: "run" starts the last word of "start a run…".
    expect(full('a run')[0]?.label).toBe('start a run…');
  });

  test('a group whose actions match only as a subsequence comes after go-to, and a view the query names leads', () => {
    const run: Subject = { kind: 'run', repo: 'alpha', runId: 'A-LIVE' };
    // "restart" holds "start" mid-word: the subject's group falls behind go-to; start a run still leads.
    const rows = full('start', run, { run: runActions });
    expect(groups(rows)).toEqual(['general', 'goto', 'subject']);
    expect(rows.at(-1)?.label).toBe('restart');
    // "queue" names the Queues view, which leads before poll every queue.
    expect(full('queue')[0]).toMatchObject({ group: 'goto', label: 'Queues' });
    expect(full('queue').map((row) => row.label)).toContain('poll every queue');
  });

  test('a subsequence of a go-to row is found only within one word, from its first letter', () => {
    // FAKE-13's title has a, l, p, h, a only spread over its words.
    expect(fuzzy('alpha', 'Add log phrase handling')).toBeDefined();
    expect(gotoRows('alpha', machine, NOW).map((row) => row.lead)).not.toContain('FAKE-13');
    expect(rank('hndl', [], ['Add log phrase handling'])).toEqual({ tier: 3, score: 1 });
    expect(rank('andl', [], ['Add log phrase handling'])).toBeUndefined();
    // A key is no exception: its letters may not skip over its separators, though a typed separator matches one.
    expect(wordFuzzy('fake-100', 'FAKE-12-01M7D000')).toBeUndefined();
    expect(wordFuzzy('fk1', 'FAKE-1')).toBeUndefined();
    expect(wordFuzzy('fk-1', 'FAKE-1')).toBe(2);
    expect(wordFuzzy('q s', 'queue store')).toBe(4);
    expect(wordFuzzy('st', 'restart')).toBeUndefined();
    expect(gotoRows('FAKE-100', machine, NOW).map((row) => row.lead)).toEqual(['FAKE-100', 'FAKE-100']);
  });

  test("a repository's name lists the repository, then its queues and live runs, and a run that ended stays last", () => {
    const listed = (query: string) => gotoRows(query, machine, NOW).map((row) => [row.hint, row.lead ?? row.label]);
    expect(listed('alpha')).toEqual([
      ['repository', 'alpha'],
      ['queue', 'alpha › ticket-to-pr'],
      ['alpha › unknown', 'LIFE-204'],
      ['alpha › unknown', 'FAKE-12'],
    ]);
    expect(listed('alp')).toEqual(listed('alpha'));
    // Two letters list no run for its repository's sake: FAKE-12 matches "al" nowhere else.
    expect(listed('al').map(([, lead]) => lead)).not.toContain('FAKE-12');
  });

  test("a queue item's row reads its key, its title and repository › workflow, once for each queue it is in", () => {
    const rows = gotoRows('FAKE-100', machine, NOW);
    expect(rows.map((row) => [row.lead, row.label, row.hint, row.status])).toEqual([
      ['FAKE-100', 'Both queues', 'alpha › ticket-to-pr', 'queued'],
      ['FAKE-100', 'Both queues', 'beta › review', 'parked'],
    ]);
    // A repository's name lists its queue once, though the queue matches the name on its own too.
    expect(gotoRows('beta', machine, NOW).filter((row) => row.hint === 'queue')).toHaveLength(1);
    // The run of an item reads as the item does: the run carries no id, as the icon tells them apart.
    const withRun = structuredClone(machine) as unknown as { runs: unknown[] }[];
    withRun[0]?.runs.push({ ...liveRun('A-100', 'FAKE-100', 'Both queues'), workflow: 'ticket-to-pr@1' });
    const both = gotoRows('both queues', withRun as unknown as IndexRepo[], NOW);
    expect(both.map((row) => [row.lead, row.hint, row.id])).toEqual([
      ['FAKE-100', 'alpha › ticket-to-pr', undefined],
      ['FAKE-100', 'alpha › ticket-to-pr', undefined],
      ['FAKE-100', 'beta › review', undefined],
    ]);
  });

  test('a repository with no workflow is disabled for a start with the reason, and a choice with no option says so', () => {
    const beta: Subject = { kind: 'repo', repo: 'beta' };
    const why = "no workflow in beta's .sail/workflows";
    expect(subjectRows(beta, { index: machine }).find((row) => row.label === 'start a run…')).toMatchObject({
      disabled: true,
      why,
    });
    const step = stepOf({ pick: 'repo', action: 'start-run' }, { index: machine });
    expect(step.rows.map((row) => [row.label, row.disabled, row.why])).toEqual([
      ['alpha', false, undefined],
      ['beta', true, why],
    ]);
    const empty = [
      {
        name: 'beta',
        remote: null,
        runs: [],
        queues: [],
        offers: { watch: on, workflows: {}, start: { enabled: true, workflows: [] } },
      },
    ] as unknown as IndexRepo[];
    const first = stepOf({ action: 'start-run', subject: beta, data: {}, values: {}, at: 0 }, { index: empty });
    expect([first.label, first.rows, first.lines]).toEqual(['workflow', [], ['no workflow to choose']]);
    expect(stepOf({ pick: 'queue', action: 'add-ticket' }, { index: empty }).lines).toEqual(['no queue to choose']);
  });

  test('the general group leaves out what the subject group has, and the Inbox actions are there only in the Inbox', () => {
    const offering = structuredClone(machine) as unknown as { offers: Record<string, unknown> }[];
    if (offering[0] !== undefined) offering[0].offers.clean = { ...on, runs: [{ runId: 'A-DONE' }] };
    const repos = offering as unknown as IndexRepo[];
    const alpha: Subject = { kind: 'repo', repo: 'alpha' };
    const rows = menuRows(state({ subject: alpha }), { index: repos }, repos, NOW).rows.map((row) => row.label);
    for (const label of ['start a run…', 'clean all failed'])
      expect(rows.filter((each) => each === label)).toHaveLength(1);
    const queue: Subject = { kind: 'workflow', repo: 'alpha', workflow: 'ticket-to-pr' };
    const onQueue = full('', queue).map((row) => row.label);
    for (const label of ['start a run…', 'add a ticket…'])
      expect(onQueue.filter((each) => each === label)).toHaveLength(1);
    expect(labels(generalRows({ index: [], view: 'active' }))).not.toContain('dismiss');
    expect(labels(generalRows({ index: [], view: 'inbox' }))).toEqual([
      'all clear',
      'dismiss',
      'switch theme',
      'toggle inspector',
    ]);
  });

  test("a disabled general row gives the offers' one reason, no watcher running for several, else the machine's", () => {
    const closed = (whys: string[]) =>
      whys.map((why, at) => ({
        name: `r${at}`,
        runs: [],
        queues: [queueOf('w', [], { poll: { enabled: false, why }, add: { enabled: false, why }, items: {} })],
      })) as unknown as IndexRepo[];
    const why = (whys: string[]) =>
      generalRows({ index: closed(whys) }).find((row) => row.label === 'add a ticket…')?.why;
    expect(why(["no watcher is running for 'r0': sail watch w first"])).toBe(
      "no watcher is running for 'r0': sail watch w first",
    );
    expect(
      why(["no watcher is running for 'r0': sail watch w first", "no watcher is running for 'r1': sail watch w first"]),
    ).toBe('no watcher is running');
    expect(why(["no watcher is running for 'r0': sail watch w first", "r1 does not watch 'w'"])).toBe(
      'no queue is watched from this clone',
    );
    const starts = [
      {
        name: 'a',
        runs: [],
        queues: [],
        offers: { watch: on, workflows: {}, start: { enabled: true, workflows: [] } },
      },
      {
        name: 'b',
        runs: [],
        queues: [],
        offers: { watch: on, workflows: {}, start: { enabled: true, workflows: [] } },
      },
    ] as unknown as IndexRepo[];
    expect(generalRows({ index: starts }).find((row) => row.label === 'start a run…')?.why).toBe(
      'no repository has a workflow in .sail/workflows',
    );
    const gone = { enabled: false, why: '/a/.sail no longer exists', workflows: [] };
    const mixed = [
      { ...starts[0], offers: { watch: on, workflows: {}, start: gone } },
      starts[1],
    ] as unknown as IndexRepo[];
    expect(generalRows({ index: mixed }).find((row) => row.label === 'start a run…')?.why).toBe(
      'no repository can start a run',
    );
  });

  test("when every row of the subject is disabled for one reason, the model says it once and the rows don't", () => {
    const reason = "no watcher is running for 'beta': sail watch ticket-to-pr first";
    const shut = structuredClone(index) as unknown as { queues: { offers: { items: Record<string, unknown> } }[] }[];
    const offers = shut[1]?.queues[0]?.offers;
    if (offers === undefined) throw new Error('no offers');
    offers.items['ticket:FAKE-6'] = { move: { enabled: false, why: reason }, drop: { enabled: false, why: reason } };
    const repos = shut as unknown as IndexRepo[];
    const six: Subject = { ...ITEM, item: 'ticket:FAKE-6' };
    for (const mode of ['full', 'context'] as const) {
      const model = menuRows(state({ mode, subject: six }), { index: repos }, repos, NOW);
      expect(model.why).toBe(reason);
      const own = model.rows.filter((row) => row.group === 'subject');
      expect(own.map((row) => [row.label, row.disabled, row.why])).toEqual([
        ['drop', true, undefined],
        ['move up', true, undefined],
        ['move to the top', true, undefined],
      ]);
    }
    // Reasons that differ stay on their rows.
    const mixed = menuRows(state({ subject: { ...ITEM, item: 'ticket:FAKE-6' } }), source(), index, NOW);
    expect(mixed.why).toBeUndefined();
    expect(mixed.rows.find((row) => row.label === 'drop')?.why).toBe('no watcher is running');
  });

  describe('a reason that two or more disabled rows share, beside rows that are not', () => {
    const reason = "no watcher is running for 'beta': sail watch ticket-to-pr first";
    const six: Subject = { ...ITEM, item: 'ticket:FAKE-6' };
    const withOffers = (items: Record<string, unknown>) => {
      const copy = structuredClone(index) as unknown as { queues: { offers: { items: Record<string, unknown> } }[] }[];
      const offers = copy[1]?.queues[0]?.offers;
      if (offers === undefined) throw new Error('no offers');
      offers.items['ticket:FAKE-6'] = items;
      return copy as unknown as IndexRepo[];
    };
    const own = (repos: IndexRepo[]) => {
      const model = menuRows(state({ subject: six }), { index: repos }, repos, NOW);
      return { model, rows: model.rows.filter((row) => row.group === 'subject') };
    };

    test('an enabled row and two rows disabled for one reason: the reason is said once and leaves those rows', () => {
      const { model, rows } = own(withOffers({ drop: { enabled: true }, move: { enabled: false, why: reason } }));
      expect(model.why).toBe(reason);
      expect(rows.map((row) => [row.label, row.disabled, row.why])).toEqual([
        ['drop', false, undefined],
        ['move up', true, undefined],
        ['move to the top', true, undefined],
      ]);
    });

    test('a row disabled for another reason keeps its own', () => {
      const { model, rows } = own(
        withOffers({ drop: { enabled: false, why: 'it is running' }, move: { enabled: false, why: reason } }),
      );
      expect(model.why).toBe(reason);
      expect(rows.map((row) => [row.label, row.why])).toEqual([
        ['drop', 'it is running'],
        ['move up', undefined],
        ['move to the top', undefined],
      ]);
    });

    test('one disabled row alone keeps its reason and the model says none', () => {
      const { model, rows } = own(withOffers({ drop: { enabled: false, why: reason }, move: { enabled: true } }));
      expect(model.why).toBeUndefined();
      expect(rows.map((row) => [row.label, row.why])).toEqual([
        ['drop', reason],
        ['move up', undefined],
        ['move to the top', undefined],
      ]);
    });

    test('two reasons with two rows each: the one with most rows, the first on a tie, is said', () => {
      const row = (label: string, why: string) =>
        ({ group: 'subject', label, why, disabled: true, run: { show: 'x' } }) as unknown as MenuRow;
      expect(sharedWhy([row('a1', 'A'), row('b1', 'B'), row('b2', 'B'), row('b3', 'B')])).toBe('B');
      expect(sharedWhy([row('a1', 'A'), row('b1', 'B'), row('a2', 'A'), row('b2', 'B')])).toBe('A');
      expect(sharedWhy([row('a1', 'A'), row('b1', 'B')])).toBeUndefined();
    });
  });
});

test("a run's go-to row reads its key, title, status and repository › workflow", () => {
  const run = {
    ...ticketRun('FAKE-1-RUN', 'FAKE-1', 'Fix the parser'),
    workflow: 'ticket-to-pr@3',
    status: { status: 'failed' },
  };
  const pr = {
    runId: 'P-1',
    workflow: 'review',
    source: { kind: 'pr', number: 12 },
    summary: { totals: { usage: {} } },
  };
  const bare = { runId: 'BARE-1', summary: { totals: { usage: {} } } };
  const one = gotoRows('fake-1', runsIndex([run]), NOW)[0];
  expect(one).toMatchObject({
    lead: 'FAKE-1',
    label: 'Fix the parser',
    status: 'failed',
    hint: 'alpha › ticket-to-pr',
  });
  expect(one?.id).toBeUndefined();
  expect(gotoRows('p-1', runsIndex([pr]), NOW)[0]).toMatchObject({ lead: 'PR #12', label: '', hint: 'alpha › review' });
  expect(gotoRows('bare', runsIndex([bare]), NOW)[0]).toMatchObject({ lead: 'BARE-1' });
});

test("a run's go-to row carries its random part only when another listed row reads the same", () => {
  const twin = (id: string) => ticketRun(`FAKE-1-${id}`, 'FAKE-1', 'Fix the parser');
  const rows = gotoRows(
    'fake-1',
    runsIndex([twin('AAA'), twin('BBB'), ticketRun('FAKE-1-CCC', 'FAKE-1', 'Other')]),
    NOW,
  );
  const byLabel = (label: string) => rows.filter((row) => row.label === label).map((row) => row.id);
  expect(byLabel('Fix the parser').sort()).toEqual(['AAA', 'BBB']);
  expect(byLabel('Other')).toEqual([undefined]);
});

test('rank scores exact, prefix, whole title words and subsequence apart', () => {
  expect(rank('FAKE-1', ['fake-1'], [])).toEqual({ tier: 0, score: 0 });
  expect(rank('fake-1', ['FAKE-12', 'FAKE-100'], [])).toEqual({ tier: 1, score: 1 });
  expect(rank('queue store', [], ['Refactor queue-store to use a single write path'])).toEqual({ tier: 2, score: 0 });
  expect(rank('rfctr', ['x'], ['Refactor queue-store to use a single write path'])?.tier).toBe(3);
  // A subsequence spread over several words is no match.
  expect(rank('qsp', ['x'], ['Refactor queue-store to use a single write path'])).toBeUndefined();
  expect(rank('zzz', ['x'], ['y'])).toBeUndefined();
  // Half the words of the query are not enough for the title tier.
  expect(rank('queue zebra', [], ['queue store'])).toBeUndefined();
});

test('go-to ranks an exact key, then a prefix, then whole title words, then a subsequence', () => {
  const runs = [
    ticketRun('R-4', 'ZZ-4', 'Move the payroll logic'),
    ticketRun('R-3', 'ZZ-3', 'Keep the poll interval short'),
    ticketRun('R-2', 'POLLY-2', 'Another thing'),
    ticketRun('POLL', 'ZZ-1', 'Something else'),
  ];
  const order = (list: unknown[]) => gotoRows('poll', runsIndex(list), NOW).map((row) => row.run);
  const run = (id: string) => ({ goto: { kind: 'run' as const, repo: 'alpha', runId: id } });
  const want = [run('POLL'), run('R-2'), run('R-3'), run('R-4')];
  expect(order(runs)).toEqual(want);
  expect(order([...runs].reverse())).toEqual(want);
});

test("a query that is a ticket key in full lists only that ticket's runs while any exist", () => {
  const runs = [
    ticketRun('A-1', 'FAKE-23', 'One'),
    ticketRun('A-2', 'FAKE-2', 'Two'),
    ticketRun('A-3', 'FAKE-25', 'Three'),
    ticketRun('A-4', 'FAKE-62', 'Four'),
    ticketRun('A-5', 'FAKE-X6', 'Five'),
  ];
  const ids = (query: string) => runIds(gotoRows(query, runsIndex(runs), NOW));
  expect(ids('Fake-2')).toEqual(['A-2']);
  expect(ids('fake-23')).toEqual(['A-1']);
  expect(ids('fake-6')).toEqual(['A-4', 'A-5']);
  // No run of the ticket: the ordinary ranking applies, an item at the exact tier.
  expect(gotoRows('fake-5', index, NOW).map((row) => row.lead)).toEqual(['FAKE-5']);
  // A full key lists no item, queue or repository, even one that matches.
  const mixed = JSON.parse(JSON.stringify(index)) as IndexRepo[];
  (mixed[0] as unknown as { runs: unknown[] }).runs = [ticketRun('FAKE-5-R', 'FAKE-5', 'Mine')];
  expect(runIds(gotoRows('FAKE-5', mixed, NOW))).toEqual(['FAKE-5-R']);
});

test('a pull-request run is a full key by its number as the list shows it', () => {
  const pr = { runId: 'P-1', source: { kind: 'pr', number: 12 }, summary: { totals: { usage: {} } } };
  expect(runIds(gotoRows('pr #12', runsIndex([pr]), NOW))).toEqual(['P-1']);
  expect(runIds(gotoRows('#12', runsIndex([pr, ticketRun('T-1', 'FAKE-1', 'x')]), NOW))).toEqual(['P-1']);
});

test('equal rows keep the index order, and at most eight are listed', () => {
  const runs = Array.from({ length: 10 }, (_, at) => ticketRun(`Q-${at}`, `K-${at}`, 'Same words'));
  const rows = gotoRows('same words', runsIndex(runs), NOW);
  expect(rows).toHaveLength(8);
  expect(runIds(rows)).toEqual((listRepos(runsIndex(runs), NOW)[0]?.runs ?? []).slice(0, 8).map((run) => run.runId));
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
  expect(model.head).toBe('FAKE-1-RUN');
  expect(labels(model.rows)).toEqual(['spec', 'tests']);
  expect(model.step?.label).toBe('from');
});

describe('the chip while a step is open', () => {
  const alpha: Subject = { kind: 'repo', repo: 'alpha' };
  const startStep = (at: number) => ({ action: 'start-run', subject: alpha, data: {}, values: {}, at }) as const;

  test('a pick step has no subject yet, so the opening subject keeps the chip, and none when the menu has none', () => {
    const pick = { pick: 'repo', action: 'start-run' } as const;
    expect(menuRows(state({ subject: RUN, steps: [pick] }), source(), index, NOW).head).toBe('FAKE-1-RUN');
    expect(menuRows(state({ steps: [pick] }), source(), index, NOW).head).toBeUndefined();
  });

  test('once the repository is chosen the chip names it on every later step, whatever the menu opened on', () => {
    for (const at of [0, 1]) {
      expect(menuRows(state({ subject: RUN, steps: [startStep(at)] }), source(), index, NOW).head).toBe('alpha');
      expect(menuRows(state({ steps: [startStep(at)] }), source(), index, NOW).head).toBe('alpha');
    }
  });

  test('a queue chosen for an action names that queue', () => {
    const queue = { action: 'add-ticket', subject: QUEUE, data: {}, values: {}, at: 0 } as const;
    expect(menuRows(state({ subject: RUN, steps: [queue] }), source(), index, NOW).head).toBe('beta › ticket-to-pr');
  });
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

test('clean all failed is a general row while a repository offers it, and is left out otherwise', () => {
  const offering = [
    {
      name: 'alpha',
      runs: [],
      queues: [],
      offers: { watch: on, workflows: {}, clean: { ...on, runs: [{ runId: 'A-1' }] } },
    },
  ] as unknown as IndexRepo[];
  const rows = generalRows({ index: offering });
  expect(rows[0]).toEqual({
    group: 'general',
    label: 'clean all failed',
    disabled: false,
    run: { act: 'clean-failed', subject: { kind: 'none' }, data: {} },
  });
  expect(labels(generalRows({ index: [] }))).not.toContain('clean all failed');
});

test('an empty query lists the four views with their keys, and a view opens by its own word', () => {
  expect(gotoRows('', index, NOW).map((row) => [row.label, row.hint, row.key, row.run])).toEqual([
    ['Inbox', 'view', '1', { show: 'inbox' }],
    ['Active', 'view', '2', { show: 'active' }],
    ['Queues', 'view', '3', { show: 'queues' }],
    ['History', 'view', '4', { show: 'history' }],
  ]);
  expect(gotoRows('hist', index, NOW).map((row) => row.label)).toEqual(['History']);
  expect(gotoRows('inbox', index, NOW)[0]?.run).toEqual({ show: 'inbox' });
  // Two letters of a view's word are too few, and a view is no subsequence match.
  expect(gotoRows('hi', index, NOW).map((row) => row.hint)).not.toContain('view');
  expect(gotoRows('hsty', index, NOW).map((row) => row.hint)).not.toContain('view');
});

test("a kind's own word lists the kind: queue the Queues view then every queue, repo every repository", () => {
  const hints = (query: string) => gotoRows(query, index, NOW).map((row) => [row.hint, row.label]);
  expect(hints('queue')).toEqual([
    ['view', 'Queues'],
    ['queue', 'beta › ticket-to-pr'],
  ]);
  expect(hints('queues')).toEqual(hints('queue'));
  expect(hints('repo')).toEqual([
    ['repository', 'alpha'],
    ['repository', 'beta'],
  ]);
  // A word typed in part still finds the kind from its third letter, and no sooner.
  expect(hints('que').map(([hint]) => hint)).toEqual(['view', 'queue']);
  expect(hints('qu').map(([hint]) => hint)).not.toContain('view');
});

test('a run that ended comes after every other row, and is left out when it matches only as a subsequence', () => {
  const withStatus = (runId: string, key: string, title: string, status: string) => ({
    ...ticketRun(runId, key, title),
    status: { status },
  });
  const runs = [
    withStatus('DONE-1', 'ZZ-1', 'Refactor the queue store', 'completed'),
    withStatus('FAIL-1', 'ZZ-2', 'Queue store loses a write', 'failed'),
    withStatus('LIVE-1', 'ZZ-3', 'Speed up the queue store', 'running'),
    withStatus('HELD-1', 'ZZ-4', 'Queue store on disk', 'suspended'),
  ];
  const all = runIds(gotoRows('queue store', runsIndex(runs), NOW));
  expect([all.slice(0, 2).sort(), all.slice(2).sort()]).toEqual([
    ['HELD-1', 'LIVE-1'],
    ['DONE-1', 'FAIL-1'],
  ]);
  // A subsequence of a title finds the live runs, and no run that ended.
  expect(runIds(gotoRows('stre', runsIndex(runs), NOW)).sort()).toEqual(['HELD-1', 'LIVE-1']);
  // Its ticket key in full still lists a run that ended.
  expect(runIds(gotoRows('zz-1', runsIndex(runs), NOW))).toEqual(['DONE-1']);
  // A queue and its item come before a finished run that matches as well.
  const mixed = JSON.parse(JSON.stringify(index)) as IndexRepo[];
  (mixed[0] as unknown as { runs: unknown[] }).runs = [withStatus('DONE-2', 'ZZ-9', 'Add a widget', 'completed')];
  expect(gotoRows('widget', mixed, NOW).map((row) => row.hint)).toEqual(['beta › ticket-to-pr', 'alpha › unknown']);
});
