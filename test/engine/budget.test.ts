// A run's budget (budget.ts): the workflow's override of project.yaml's, what a run has used folded from its events, the
// tracker that warns, says when the budget is used up and hands each agent request its share of what is left, and the
// refusal of a resume that a raise wouldn't take back under its budget. Events are written by hand with stamp().
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BudgetOptions,
  type BudgetTracker,
  budgetAfterRaises,
  raiseProblem,
  recordIn,
  runBudgetOf,
  suspension,
  trackBudget,
  usedOf,
  workflowBudgetProblem,
} from '../../src/engine/budget';
import type { NewEvent, SailEvent } from '../../src/events/types';
import type { Harness, HarnessRequest } from '../../src/ports/harness';
import type { HarnessResult } from '../../src/ports/types';
import { runEnd, runStart, session, stamp } from '../helpers/events';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const leased: NewEvent = { type: 'workspace:leased', remote: 'fake://codehost/fixture', branch: 'sail/FAKE-1' };
const started = (key: string): NewEvent => ({
  type: 'harness:session_start',
  key,
  adapter: 'fake',
  sessionId: `session-${key}`,
  model: 'claude-sonnet-5',
});
const update = (key: string, turn: number, costUsdSoFar: number): NewEvent => ({
  type: 'usage:update',
  key,
  turn,
  tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  costUsdSoFar,
});
const ended = (key: string, costUsd: number): NewEvent =>
  session(key, { turns: 1, toolCalls: 0, denials: 0, usage: { costUsd } });
const raisedTo = (budget: { maxUsd?: number; maxMinutes?: number }, by: { usd?: number; minutes?: number }): NewEvent =>
  ({ type: 'budget:raised', ...by, budget }) as NewEvent;

/** The events of `list`, stamped as the bus would, each at the ms it is given with. */
const events = (...list: [number, NewEvent][]): SailEvent[] => stamp(...list);

/** spec's session in the fixture, ended at $0.3125, after the run's start. */
const SPEC_SPENT = events([0, runStart({ maxUsd: 0.5 })], [0, started('spec#1')], [0, ended('spec#1', 0.3125)]);

test("runBudgetOf gives the workflow's budget over the project's field by field, keeps only the fields given, and nothing when none is", () => {
  expect([
    runBudgetOf({ maxUsd: 25, maxMinutes: 90 }, { maxUsd: 0.5 }),
    runBudgetOf(undefined, { maxMinutes: 30 }),
    runBudgetOf({ maxUsd: 25 }, { maxUsd: undefined } as unknown as { maxUsd?: number }),
    runBudgetOf(undefined, undefined),
    runBudgetOf({}, {}),
  ]).toEqual([{ maxUsd: 0.5, maxMinutes: 90 }, { maxMinutes: 30 }, { maxUsd: 25 }, undefined, undefined]);
});

test('workflowBudgetProblem takes a left-out budget, an empty one and numbers of 0 or more, and names an infinite one', () => {
  expect([
    workflowBudgetProblem(undefined),
    workflowBudgetProblem({}),
    workflowBudgetProblem({ maxUsd: 0 }),
    workflowBudgetProblem({ maxUsd: 1.5, maxMinutes: 30 }),
    workflowBudgetProblem({ maxUsd: Number.POSITIVE_INFINITY }),
  ]).toEqual([undefined, undefined, undefined, undefined, 'maxUsd must be a number of 0 or more: Infinity']);
});

test("usedOf adds what settled sessions spent to an open session's last reading", () => {
  const list = events(
    [0, runStart({ maxUsd: 0.5 })],
    [10, started('spec#1')],
    [20, update('spec#1', 1, 0.078125)],
    [30, ended('spec#1', 0.3125)],
    [40, started('implement#1')],
    [50, update('implement#1', 1, 0.0952)],
    [60, update('implement#1', 2, 0.1904)],
  );
  expect(usedOf(list).usd).toBe(0.5029);
});

test('a session started again under a key still open is settled at its last reading, and each session counts once', () => {
  const list = events(
    [0, runStart()],
    [10, started('spec#1')],
    [20, update('spec#1', 1, 0.1)],
    [30, started('spec#1')],
    [40, update('spec#1', 1, 0.05)],
    [50, ended('spec#1', 0.05)],
  );
  expect(usedOf(list).usd).toBe(0.15);
});

test('an interrupted session that a resume ends later, as reconcile() does, counts once, beside the try that runs next', () => {
  const list = events(
    [0, runStart()],
    [10, started('implement#1')],
    [20, update('implement#1', 1, 0.1)],
    [30, runEnd('suspended', 1, { stopReason: 'interrupted' })],
    [DAY, leased],
    [DAY + 10, ended('implement#1', 0.1)],
    [DAY + 20, started('implement#1')],
    [DAY + 30, ended('implement#1', 0.2)],
  );
  expect(usedOf(list).usd).toBe(0.3);
});

test("minutes are each process's active time: the days a run waits suspended, or dead after a crash, aren't counted", () => {
  const list = events(
    // The start: run:start, then its lease, which opens no segment of its own. Suspended after 10 minutes.
    [0, runStart({ maxMinutes: 90 })],
    [1, leased],
    [10 * MINUTE, runEnd('suspended', 1, { stopReason: 'interrupted' })],
    // A resume a day later, killed 5 minutes in: its segment ends at its last event.
    [DAY, leased],
    [DAY + 5 * MINUTE, started('spec#1')],
    // A resume the day after, which crashes 3 minutes in.
    [2 * DAY, leased],
    [2 * DAY + 3 * MINUTE, { type: 'error:crash', message: 'boom' }],
    // The last resume, 2 minutes in so far.
    [3 * DAY, leased],
    [3 * DAY + 2 * MINUTE, started('implement#1')],
  );
  expect(usedOf(list).minutes).toBe(20);
});

test("the budget after raises is the header's, with the last raise's budget over it", () => {
  const header = { maxUsd: 0.5, maxMinutes: 90 };
  expect([
    budgetAfterRaises(header, SPEC_SPENT),
    budgetAfterRaises(header, events([0, raisedTo({ maxUsd: 5.5, maxMinutes: 90 }, { usd: 5 })])),
    budgetAfterRaises(
      header,
      events(
        [0, raisedTo({ maxUsd: 5.5, maxMinutes: 90 }, { usd: 5 })],
        [1, raisedTo({ maxUsd: 5.5, maxMinutes: 120 }, { minutes: 30 })],
      ),
    ),
  ]).toEqual([header, { maxUsd: 5.5, maxMinutes: 90 }, { maxUsd: 5.5, maxMinutes: 120 }]);
});

/** A tracker's world: what it emitted, each stamped on after `prior`, and what it confirmed on disk. */
interface World {
  emitted: SailEvent[];
  recorded: number[];
  /** The monotonic clock the tracker reads, in ms: a test moves it. */
  now: number;
}

/** The tracker for `budget`, which must exist, over `prior`, in a fresh world. */
function tracked(
  budget: BudgetOptions['budget'],
  prior: readonly SailEvent[] = [],
  record?: (event: SailEvent) => void,
): { tracker: BudgetTracker; world: World } {
  const world: World = { emitted: [], recorded: [], now: 0 };
  const tracker = trackBudget({
    budget,
    prior,
    emit: (event) => {
      const stamped = { seq: prior.length + world.emitted.length + 1, ts: 'now', runId: 'run', ...event } as SailEvent;
      world.emitted.push(stamped);
      return stamped;
    },
    record:
      record ??
      ((event) => {
        world.recorded.push(event.seq);
      }),
    elapsed: () => world.now,
  });
  expect(tracker).toBeDefined();
  return { tracker: tracker as BudgetTracker, world };
}

/** Each emitted event without its envelope. */
const payloads = (list: readonly SailEvent[]) => list.map(({ seq: _s, ts: _t, runId: _r, ...rest }) => rest);

/** Feeds `list` to the tracker, numbered on from `from`. */
function observe(tracker: BudgetTracker, from: number, ...list: NewEvent[]): void {
  for (const [i, event] of list.entries()) {
    tracker.observe({ seq: from + i, ts: 'now', runId: 'run', ...event } as SailEvent);
  }
}

test('a run with no budget gets no tracker, and a run with one does', () => {
  const options = { prior: [], emit: (event: NewEvent) => event as SailEvent, record: () => {}, elapsed: () => 0 };
  expect([trackBudget({ ...options, budget: undefined }), trackBudget({ ...options, budget: { maxUsd: 1 } })]).toEqual([
    undefined,
    expect.objectContaining({ over: expect.any(Function) }),
  ]);
});

test("the run's budget:warning fires once at 80% of it, with no key, and not again on a later event under the limit", () => {
  const { tracker, world } = tracked({ maxUsd: 0.5 }, SPEC_SPENT);
  observe(tracker, 4, started('implement#1'), update('implement#1', 1, 0.0952), update('implement#1', 2, 0.15));
  expect(payloads(world.emitted)).toEqual([{ type: 'budget:warning', budget: 'usd', limit: 0.5, used: 0.4077 }]);
});

test('a raise re-arms the warning: the raised budget warns again at 80% of it', () => {
  const { tracker, world } = tracked({ maxUsd: 0.5 }, SPEC_SPENT);
  observe(tracker, 4, started('implement#1'), update('implement#1', 1, 0.0952));
  tracker.raise({ usd: 1 });
  observe(tracker, 7, update('implement#1', 2, 0.9));
  expect(payloads(world.emitted)).toEqual([
    { type: 'budget:warning', budget: 'usd', limit: 0.5, used: 0.4077 },
    { type: 'budget:raised', usd: 1, budget: { maxUsd: 1.5 } },
    { type: 'budget:warning', budget: 'usd', limit: 1.5, used: 1.2125 },
  ]);
});

test("a warning and an exceeded budget the prior events hold are not given again, and a step's own are not the run's", () => {
  const prior = events(
    [0, runStart({ maxUsd: 0.5 })],
    [10, started('spec#1')],
    [20, ended('spec#1', 0.6)],
    [30, { type: 'budget:warning', budget: 'usd', limit: 0.5, used: 0.6 }],
    [40, { type: 'budget:exceeded', budget: 'usd', limit: 0.5, used: 0.6 }],
    [50, { type: 'budget:warning', key: 'spec#1', budget: 'minutes', limit: 0.1, used: 0.09 }],
  );
  const { tracker, world } = tracked({ maxUsd: 0.5, maxMinutes: 0.1 }, prior);
  world.now = 0.09 * MINUTE;
  const over = tracker.over();
  expect({ over, emitted: payloads(world.emitted) }).toEqual({
    over: { budget: 'usd', limit: 0.5, used: 0.6 },
    // The prior events' 50 ms, and this process's 0.09 minutes.
    emitted: [{ type: 'budget:warning', budget: 'minutes', limit: 0.1, used: 0.090833 }],
  });
});

test('budget:exceeded fires once as the run reaches its limit, and over() names the budget, its limit and the use; under it, over() is undefined', () => {
  const { tracker, world } = tracked({ maxUsd: 0.5 }, SPEC_SPENT);
  const before = tracker.over();
  observe(tracker, 4, started('implement#1'), update('implement#1', 1, 0.0952), update('implement#1', 2, 0.1904));
  observe(tracker, 7, ended('implement#1', 0.1904));
  expect({ before, after: tracker.over(), emitted: payloads(world.emitted) }).toEqual({
    before: undefined,
    after: { budget: 'usd', limit: 0.5, used: 0.5029 },
    emitted: [
      { type: 'budget:warning', budget: 'usd', limit: 0.5, used: 0.4077 },
      { type: 'budget:exceeded', budget: 'usd', limit: 0.5, used: 0.5029 },
    ],
  });
});

test("minutes are the earlier processes' and this one's elapsed() since the tracker was made: past the limit, over() says so with no event in between", () => {
  const prior = events(
    [0, runStart({ maxMinutes: 31 })],
    [30 * MINUTE, runEnd('suspended', 1, { stopReason: 'interrupted' })],
  );
  const world = { now: 5_000 };
  const tracker = trackBudget({
    budget: { maxMinutes: 31 },
    prior,
    emit: (event) => event as SailEvent,
    record: () => {},
    elapsed: () => world.now,
  });
  expect(tracker).toBeDefined();
  const under = tracker?.over();
  world.now = 5_000 + 61_000;
  expect({ under, over: tracker?.over() }).toEqual({
    under: undefined,
    over: { budget: 'minutes', limit: 31, used: 31.016667 },
  });
});

/** A harness that answers every request done once `release()` is called for its key, and keeps the requests. */
function heldHarness(): Harness & { requests: HarnessRequest[]; release(key: string, fails?: boolean): void } {
  const requests: HarnessRequest[] = [];
  const waiting = new Map<string, (fails: boolean) => void>();
  const done: HarnessResult = {
    outcome: 'done',
    output: {},
    sessionId: 's',
    usage: { costUsd: 0 },
    transcript: '',
    raw: null,
  };
  return {
    name: 'held',
    requests,
    capabilities: () => ({ structuredOutput: true, permissions: true, usage: true, abort: true, budgets: ['usd'] }),
    run(request) {
      requests.push(request);
      return new Promise((resolve, reject) => {
        waiting.set(request.key, (fails) => (fails ? reject(new Error('lost')) : resolve(done)));
      });
    },
    release(key, fails = false) {
      waiting.get(key)?.(fails);
    },
  };
}

const ask = (key: string, budget: HarnessRequest['budget']): HarnessRequest => ({
  key,
  try: 1,
  prompt: '',
  cwd: '/',
  env: {},
  model: 'claude-sonnet-5',
  permissions: { read: [], write: [], commands: [] },
  budget,
  outputSchema: {},
});

test("each request is handed what the run has left, its turns kept and a step budget smaller than what is left kept, and the harness's name and capabilities pass through", async () => {
  const { tracker } = tracked({ maxUsd: 0.5, maxMinutes: 90 }, SPEC_SPENT);
  const inner = heldHarness();
  const harness = tracker.harness(inner);
  const implement = harness.run(ask('implement#1', { maxTurns: 60, maxUsd: 5, maxMinutes: 20 }));
  inner.release('implement#1');
  await implement;
  const tests = harness.run(ask('tests#1', { maxTurns: 3, maxUsd: 0.05, maxMinutes: 120 }));
  inner.release('tests#1');
  await tests;
  expect({
    budgets: inner.requests.map((request) => request.budget),
    name: harness.name,
    capabilities: harness.capabilities(),
  }).toEqual({
    budgets: [
      { maxTurns: 60, maxUsd: 0.1875, maxMinutes: 20 },
      { maxTurns: 3, maxUsd: 0.05, maxMinutes: 90 },
    ],
    name: 'held',
    capabilities: inner.capabilities(),
  });
});

test('requests open at once share what is left: each is handed what the others hold less, and a share goes back when its run() settles, a rejected one too', async () => {
  const { tracker } = tracked({ maxUsd: 1 });
  const inner = heldHarness();
  const harness = tracker.harness(inner);
  const own = { maxTurns: 10, maxUsd: 5, maxMinutes: 5 };
  const first = harness.run(ask('a#1', { ...own, maxUsd: 0.7 }));
  const second = harness.run(ask('b#1', own));
  inner.release('a#1');
  inner.release('b#1', true);
  const settled = await Promise.allSettled([first, second]);
  const third = harness.run(ask('c#1', own));
  inner.release('c#1');
  await third;
  expect({
    handed: inner.requests.map((request) => request.budget.maxUsd),
    settled: settled.map((each) => each.status),
  }).toEqual({ handed: [0.7, 0.3, 1], settled: ['fulfilled', 'rejected'] });
});

test("a request the others' shares leave nothing is handed $0.000001, never $0, which claude-code refuses, and counts as narrowed (review R1-1)", async () => {
  const { tracker } = tracked({ maxUsd: 1 });
  const inner = heldHarness();
  const harness = tracker.harness(inner);
  const own = { maxTurns: 10, maxUsd: 2, maxMinutes: 5 };
  const first = harness.run(ask('a#1', own));
  const second = harness.run(ask('b#1', own));
  inner.release('a#1');
  inner.release('b#1');
  await Promise.all([first, second]);
  expect({
    handed: inner.requests.map((request) => request.budget.maxUsd),
    narrowed: tracker.narrowed('b#1'),
  }).toEqual({ handed: [1, 0.000001], narrowed: true });
});

test('narrowed() holds for a request the run narrowed in the budget its session exceeded, or in any when it named none, and not for one over a budget of its own', async () => {
  const { tracker } = tracked({ maxUsd: 0.5 });
  const inner = heldHarness();
  const harness = tracker.harness(inner);
  const narrow = { maxTurns: 10, maxUsd: 5, maxMinutes: 5 };
  const own = { maxTurns: 10, maxUsd: 0.1, maxMinutes: 5 };
  const keys = ['usd#1', 'turns#1', 'silent#1'];
  const asked = keys.map((key) => harness.run(ask(key, narrow)));
  observe(
    tracker,
    1,
    { type: 'budget:exceeded', key: 'usd#1', budget: 'usd', limit: 0.5, used: 0.6 },
    { type: 'budget:exceeded', key: 'turns#1', budget: 'turns', limit: 10, used: 10 },
  );
  for (const key of keys) inner.release(key);
  await Promise.all(asked);
  // Asked alone, under what the run has left: its own budget is the smaller.
  const alone = harness.run(ask('own#1', own));
  inner.release('own#1');
  await alone;
  expect([...keys, 'own#1'].map((key) => tracker.narrowed(key))).toEqual([true, false, true, false]);
});

test("a session's end is confirmed on disk once it is folded, and a confirmation that throws is held for assertRecorded()", () => {
  const failure = new Error('events.ndjson ends with event 6, not harness:session_end 7: it is not on disk');
  const recorded: number[] = [];
  const { tracker } = tracked({ maxUsd: 5 }, [], (event) => {
    recorded.push(event.seq);
    if (event.seq === 7) throw failure;
  });
  observe(tracker, 5, started('spec#1'), ended('spec#1', 0.3), ended('spec#1', 0.1));
  let thrown: unknown;
  try {
    tracker.assertRecorded();
  } catch (error) {
    thrown = error;
  }
  expect({ recorded, thrown }).toEqual({ recorded: [6, 7], thrown: failure });
});

test('a raise emits budget:raised with what it added and the budget after it, and is confirmed on disk; a confirmation that fails throws from raise()', () => {
  const { tracker, world } = tracked({ maxUsd: 0.5, maxMinutes: 90 }, SPEC_SPENT);
  tracker.raise({ usd: 5, minutes: 30 });
  const failing = tracked({ maxUsd: 0.5 }, SPEC_SPENT, () => {
    throw new Error('not on disk');
  });
  expect({
    emitted: world.emitted.map((event) => [event.seq, ...payloads([event])]),
    recorded: world.recorded,
  }).toEqual({
    emitted: [[4, { type: 'budget:raised', usd: 5, minutes: 30, budget: { maxUsd: 5.5, maxMinutes: 120 } }]],
    recorded: [4],
  });
  expect(() => failing.tracker.raise({ usd: 1 })).toThrow('not on disk');
});

test("recordIn confirms an event that ends the run's events file, and throws for one that doesn't", () => {
  const dir = mkdtempSync(join(tmpdir(), 'sail-budget-'));
  try {
    const list = events([0, runStart()], [10, started('spec#1')]);
    writeFileSync(join(dir, 'events.ndjson'), list.map((event) => `${JSON.stringify(event)}\n`).join(''));
    const record = recordIn(dir);
    const last = list[1] as SailEvent;
    expect(() => record(last)).not.toThrow();
    expect(() => record({ ...last, seq: 3 })).toThrow(
      'events.ndjson ends with event 2, not harness:session_start 3: it is not on disk',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('suspension() gives the run:suspended and the message of a run over its dollars, and over its minutes', () => {
  expect([
    suspension({ budget: 'usd', limit: 0.5, used: 0.5029 }, 'implement#1'),
    suspension({ budget: 'minutes', limit: 90, used: 90.42 }, 'tests#1'),
  ]).toEqual([
    {
      event: { type: 'run:suspended', stopReason: 'budget_exceeded', budget: 'usd', limit: 0.5, used: 0.5029 },
      message: '$0.50 of its $0.50 used before implement#1: raise it with --raise-budget <usd>',
    },
    {
      event: { type: 'run:suspended', stopReason: 'budget_exceeded', budget: 'minutes', limit: 90, used: 90.42 },
      message: '90.42 of its 90 minutes used before tests#1: raise it with --raise-minutes <minutes>',
    },
  ]);
});

test("raiseProblem refuses a raise of a budget the run doesn't have, and a resume still at or over its budget once raised, and lets one through that a raise takes back under", () => {
  const id = 'FAKE-1-1';
  const spent = events(
    [0, runStart({ maxUsd: 0.5 })],
    [10, started('implement#1')],
    [MINUTE, ended('implement#1', 0.5029)],
  );
  expect([
    raiseProblem(id, { maxUsd: 0.5 }, spent, { minutes: 30 }),
    raiseProblem(id, { maxMinutes: 90 }, spent, { usd: 5 }),
    raiseProblem(id, { maxUsd: 0.5 }, spent),
    raiseProblem(id, { maxUsd: 0.5 }, spent, { usd: 0.001 }),
    raiseProblem(id, { maxMinutes: 1 }, spent),
    raiseProblem(id, { maxUsd: 0.5 }, spent, { usd: 5 }),
    raiseProblem(id, undefined, spent),
  ]).toEqual([
    'run FAKE-1-1 has no minute budget to raise',
    'run FAKE-1-1 has no dollar budget to raise',
    'run FAKE-1-1 has used $0.50 of its $0.50: resume it with --raise-budget <usd>',
    'run FAKE-1-1 has used $0.50 of its $0.50: resume it with --raise-budget <usd>',
    'run FAKE-1-1 has used 1 of its 1 minutes: resume it with --raise-minutes <minutes>',
    undefined,
    undefined,
  ]);
});
