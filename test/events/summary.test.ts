// summarize(): a run's events folded into its summary, one rule of the fold per case. Every summary a case folds must
// validate against sail.summary.v1.
import { expect, test } from 'bun:test';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import { type Summary, summarize } from '../../src/events/summary';
import type { NewEvent, SailEvent } from '../../src/events/types';
import {
  at,
  end,
  fetched,
  journal,
  produced,
  RUN_ID,
  resultPath,
  route,
  runEnd,
  runStart,
  session,
  stamp,
  start,
  stepEnd,
  stepStart,
} from '../helpers/events';

/** The summary of `events`, which must validate against sail.summary.v1. */
function folded(events: readonly SailEvent[]): Summary | undefined {
  const summary = summarize(events);
  expect(validateDocument('sail.summary.v1', summary).map(formatIssue)).toEqual([]);
  return summary;
}

/** How the run ended, as far as the summary says: the fields a run's end sets, those present only. */
function ending(summary: Summary | undefined): Record<string, unknown> {
  const fields = ['status', 'stopReason', 'message', 'endedAt', 'durationMs', 'result'] as const;
  return Object.fromEntries(
    fields.filter((field) => summary !== undefined && field in summary).map((f) => [f, summary?.[f]]),
  );
}

const loopIteration = (loop: string, iteration: number, max: number, from?: string): NewEvent => ({
  type: 'loop:iteration',
  loop,
  iteration,
  max,
  ...(from === undefined ? {} : { feedback: { from } }),
});

test('a run with no run:end is running, and lasts until its latest event', () => {
  const summary = folded(
    stamp(
      [0, runStart({ maxMinutes: 90 })],
      [100, start('spec#1')],
      [600, end('spec#1', 'passed', 480)],
      [620, journal('spec#1', 1, 'passed')],
      [900, { type: 'workspace:leased', remote: 'fake://codehost/fixture', branch: 'sail/FAKE-1' }],
    ),
  );
  expect(summary).toEqual({
    schema: 'sail.summary.v1',
    runId: RUN_ID,
    workflow: 'ticket-to-pr@1',
    source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli' },
    status: 'running',
    startedAt: at(0),
    durationMs: 900,
    calls: [
      { key: 'spec#1', kind: 'script', outcome: 'passed', durationMs: 480, resultPath: 'spec/call-1/result.json' },
    ],
    loops: {},
    routes: [],
    totals: { stageCalls: 1, steps: 1, toolCalls: 0, denials: 0, replays: 0, usage: { costUsd: 0 } },
    version: 1,
  });
});

test.each([
  ['failed', 'workflow_failed'],
  ['suspended', 'interrupted'],
] as const)('a %s run takes its status and stop reason from its run:end, and ends there', (status, stopReason) => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('spec#1')],
      [300, end('spec#1', 'passed', 200)],
      [320, journal('spec#1', 1, 'passed')],
      [400, runEnd(status, 2, { stopReason, message: 'stopped' })],
    ),
  );
  expect(ending(summary)).toEqual({ status, stopReason, message: 'stopped', endedAt: at(400), durationMs: 400 });
});

test('a failed run:end with a message puts it in the summary, and one without leaves no message key', () => {
  const failed = (extra: { message?: string }) =>
    folded(stamp([0, runStart()], [400, runEnd('failed', 0, { stopReason: 'workflow_failed', ...extra })]));
  expect(failed({ message: 'spec blocked: x' })?.message).toBe('spec blocked: x');
  expect(failed({})).not.toHaveProperty('message');
});

test('an event after run:end, other than error:consumer, sets the run back to running', () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [400, runEnd('suspended', 3, { stopReason: 'interrupted', message: 'stopped during spec#1' })],
      [500, loopIteration('fix', 1, 3)],
    ),
  );
  expect(ending(summary)).toEqual({ status: 'running', durationMs: 500 });
});

test('an error:consumer after run:end leaves the run as it ended', () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [400, runEnd('completed', 1, { result: { pr: 1 } })],
      [
        450,
        {
          type: 'error:consumer',
          consumer: 'summary.json',
          failed: { seq: 2, type: 'run:end' },
          message: 'EISDIR: illegal operation on a directory',
        },
      ],
    ),
  );
  expect(ending(summary)).toEqual({ status: 'completed', endedAt: at(400), durationMs: 400, result: { pr: 1 } });
});

test("replays sum every run:end's, and the last run:end's status wins", () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('spec#1')],
      [300, end('spec#1', 'passed', 200)],
      [320, journal('spec#1', 1, 'passed')],
      [400, runEnd('suspended', 3, { stopReason: 'interrupted', message: 'stopped during implement#1' })],
      [600, start('implement#1')],
      [800, end('implement#1', 'passed', 200)],
      [820, journal('implement#1', 2, 'passed')],
      [900, runEnd('completed', 5)],
    ),
  );
  expect([ending(summary), summary?.totals.replays]).toEqual([
    { status: 'completed', endedAt: at(900), durationMs: 900 },
    8,
  ]);
});

test("a key's next try keeps the call's place, and shows only that try's outcome, duration and files", () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('implement#1')],
      [150, produced('implement#1', 'a.patch')],
      [300, end('implement#1', 'error', 200)],
      [400, start('tests#1')],
      [500, end('tests#1', 'passed', 100)],
      [510, journal('tests#1', 1, 'passed')],
      [600, start('implement#1', { try: 2 })],
      [650, produced('implement#1', 'b.patch')],
      [750, end('implement#1', 'passed', 150, 2)],
      [760, journal('implement#1', 2, 'passed')],
    ),
  );
  expect(summary?.calls).toEqual([
    {
      key: 'implement#1',
      kind: 'script',
      outcome: 'passed',
      durationMs: 150,
      files: ['b.patch'],
      resultPath: 'implement/call-1/try-2/result.json',
    },
    { key: 'tests#1', kind: 'script', outcome: 'passed', durationMs: 100, resultPath: 'tests/call-1/result.json' },
  ]);
});

test("a call that has started but hasn't ended isn't listed", () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('spec#1')],
      [300, end('spec#1', 'passed', 200)],
      [320, journal('spec#1', 1, 'passed')],
      [400, start('implement#1')],
    ),
  );
  expect([summary?.calls.map((call) => call.key), summary?.totals.stageCalls]).toEqual([['spec#1'], 1]);
});

test.each<[string, string, string | null, string | undefined]>([
  [
    'names the call whose result the feedback came from',
    'tests/call-1/result.json#/output',
    'tests/call-1/result.json#/output',
    'tests#1',
  ],
  // consumed says workflow for every value no call produced, so the feedback can't be told from the call's other inputs.
  ['is left out for a feedback the workflow built', 'workflow', 'workflow', undefined],
  [
    'is a pointer that matches no result, as given',
    'elsewhere/result.json#/output',
    'elsewhere/result.json#/output',
    'elsewhere/result.json#/output',
  ],
  ['is left out when nothing consumed the latest feedback', 'tests/call-1/result.json#/output', null, undefined],
])('feedbackFrom %s', (_, from, consumed, feedbackFrom) => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('tests#1')],
      [200, end('tests#1', 'failed', 100)],
      [210, journal('tests#1', 1, 'failed')],
      [220, loopIteration('fix', 2, 3, from)],
      [300, start('implement#2', { consumed: { spec: 'spec/call-1/spec.md', feedback: consumed } })],
      [400, end('implement#2', 'passed', 100)],
      [410, journal('implement#2', 2, 'passed')],
    ),
  );
  expect(summary?.calls.at(-1)).toEqual({
    key: 'implement#2',
    kind: 'script',
    outcome: 'passed',
    durationMs: 100,
    ...(feedbackFrom === undefined ? {} : { feedbackFrom }),
    resultPath: 'implement/call-2/result.json',
  });
});

test("a loop's feedback is held until that loop exits, and an inner loop's exit leaves it", () => {
  const pointer = 'tests/call-1/result.json#/output';
  const consuming = (key: string, ms: number): [number, NewEvent][] => [
    [ms, start(key, { consumed: { feedback: pointer } })],
    [ms + 50, end(key, 'passed', 50)],
    [ms + 60, journal(key, 0, 'passed')],
  ];
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('tests#1')],
      [200, end('tests#1', 'failed', 100)],
      [210, journal('tests#1', 1, 'failed')],
      [220, loopIteration('fix', 2, 3, pointer)],
      [230, loopIteration('lint', 1, 2)],
      [240, { type: 'loop:exit', loop: 'lint', iterations: 1, max: 2, reason: 'break' }],
      ...consuming('implement#2', 300),
      [400, { type: 'loop:exit', loop: 'fix', iterations: 2, max: 3, reason: 'break' }],
      ...consuming('publish#1', 500),
    ),
  );
  expect(summary?.calls.map(({ key, feedbackFrom }) => [key, feedbackFrom])).toEqual([
    ['tests#1', undefined],
    ['implement#2', 'tests#1'],
    ['publish#1', undefined],
  ]);
});

test("a call's agent facts are its latest try's last session's, and totals sum every session", () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('implement#1', { kind: 'agent' })],
      [
        200,
        session('implement#1', {
          turns: 3,
          toolCalls: 2,
          denials: 1,
          usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.1 },
        }),
      ],
      [300, end('implement#1', 'error', 200)],
      [400, runEnd('suspended', 1, { stopReason: 'interrupted', message: 'stopped during implement#1' })],
      [500, start('implement#1', { kind: 'agent', try: 2 })],
      [
        600,
        session('implement#1', {
          turns: 1,
          toolCalls: 1,
          denials: 1,
          usage: { inputTokens: 40, cacheReadTokens: 500, outputTokens: 4, costUsd: 0.05 },
        }),
      ],
      [
        700,
        session('implement#1', {
          turns: 2,
          toolCalls: 4,
          denials: 0,
          usage: { inputTokens: 60, outputTokens: 6, costUsd: 0.2 },
        }),
      ],
      [800, end('implement#1', 'done', 300, 2)],
      [810, journal('implement#1', 1, 'done')],
    ),
  );
  expect(summary?.calls).toEqual([
    {
      key: 'implement#1',
      kind: 'agent',
      outcome: 'done',
      durationMs: 300,
      turns: 2,
      toolCalls: 4,
      denials: 0,
      costUsd: 0.2,
      resultPath: resultPath('implement#1', 2),
    },
  ]);
  expect(summary?.totals).toEqual({
    stageCalls: 1,
    steps: 1,
    toolCalls: 7,
    denials: 2,
    replays: 1,
    usage: { inputTokens: 200, cacheReadTokens: 500, outputTokens: 20, costUsd: 0.35 },
  });
});

test('a step:end without durationMs, from before it carried one, is timed from step:start to step:end', () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('publish#1', { kind: 'stage', steps: ['describe', 'open'] })],
      [200, stepStart('publish#1/describe', 1, 2, 'agent')],
      [1200, stepEnd('publish#1/describe', 1, 'done')],
      [1210, journal('publish#1/describe', 1, 'done')],
      [1600, stepStart('publish#1/open', 2, 2, 'script')],
      [2100, stepEnd('publish#1/open', 2, 'passed')],
      [2110, journal('publish#1/open', 2, 'passed')],
      [2200, end('publish#1', 'passed', 1500)],
      [2210, journal('publish#1', 3, 'passed')],
    ),
  );
  expect(summary?.calls[0]?.steps?.map((step) => step.durationMs)).toEqual([1000, 500]);
});

test("a step:end's durationMs of 0, from a step that never started, is its duration, not its step:start to step:end", () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('publish#1', { kind: 'stage', steps: ['describe', 'open'] })],
      [200, stepStart('publish#1/describe', 1, 2, 'agent')],
      [1200, stepEnd('publish#1/describe', 1, 'done', 1, 900)],
      [1210, journal('publish#1/describe', 1, 'done')],
      [1600, stepStart('publish#1/open', 2, 2, 'script')],
      [2100, stepEnd('publish#1/open', 2, 'error', 1, 0)],
      [2200, end('publish#1', 'error', 900)],
    ),
  );
  expect(summary?.calls[0]?.steps?.map((step) => step.durationMs)).toEqual([900, 0]);
});

test("a multi-step call has no kind, costs what its steps cost, and lists each step, its duration from each step:end, summing to the call's", () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('publish#1', { kind: 'stage', steps: ['describe', 'review', 'open'] })],
      [200, stepStart('publish#1/describe', 1, 3, 'agent')],
      [300, session('publish#1/describe', { turns: 4, toolCalls: 2, denials: 1, usage: { costUsd: 0.1 } })],
      [310, produced('publish#1/describe', 'pr-body.md')],
      [1200, stepEnd('publish#1/describe', 1, 'done', 1, 900)],
      [1210, journal('publish#1/describe', 1, 'done')],
      [1300, stepStart('publish#1/review', 2, 3, 'agent')],
      [1400, session('publish#1/review', { turns: 1, toolCalls: 0, denials: 0, usage: { costUsd: 0.2 } })],
      [1500, stepEnd('publish#1/review', 2, 'done', 1, 150)],
      [1510, journal('publish#1/review', 2, 'done')],
      [1600, stepStart('publish#1/open', 3, 3, 'script')],
      [1700, produced('publish#1', 'pr-body.md')],
      [2100, stepEnd('publish#1/open', 3, 'passed', 1, 400)],
      [2110, journal('publish#1/open', 3, 'passed')],
      [2200, end('publish#1', 'passed', 1450)],
      [2210, journal('publish#1', 4, 'passed')],
    ),
  );
  expect(summary?.calls).toEqual([
    {
      key: 'publish#1',
      outcome: 'passed',
      durationMs: 1450,
      costUsd: 0.3,
      files: ['pr-body.md'],
      resultPath: 'publish/call-1/result.json',
      steps: [
        {
          key: 'publish#1/describe',
          kind: 'agent',
          outcome: 'done',
          durationMs: 900,
          turns: 4,
          toolCalls: 2,
          costUsd: 0.1,
          files: ['pr-body.md'],
        },
        {
          key: 'publish#1/review',
          kind: 'agent',
          outcome: 'done',
          durationMs: 150,
          turns: 1,
          toolCalls: 0,
          costUsd: 0.2,
        },
        { key: 'publish#1/open', kind: 'script', outcome: 'passed', durationMs: 400 },
      ],
    },
  ]);
  expect(summary?.totals.steps).toBe(3);
});

test('a multi-step call that ended before its second step lists no steps', () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('publish#1', { kind: 'stage', steps: ['describe', 'open'] })],
      [200, stepStart('publish#1/describe', 1, 2, 'agent')],
      [300, session('publish#1/describe', { turns: 1, toolCalls: 0, denials: 0, usage: { costUsd: 0.1 } })],
      [400, stepEnd('publish#1/describe', 1, 'error')],
      [410, journal('publish#1/describe', 1, 'error')],
      [600, end('publish#1', 'error', 500)],
      [610, journal('publish#1', 2, 'error')],
    ),
  );
  expect(summary?.calls).toEqual([
    { key: 'publish#1', outcome: 'error', durationMs: 500, costUsd: 0.1, resultPath: 'publish/call-1/result.json' },
  ]);
});

test("an agent fact that isn't a whole number of 0 or more, or dollars of 0 or more, is left out", () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('spec#1', { kind: 'agent' })],
      [
        200,
        session('spec#1', {
          turns: -1,
          toolCalls: '3',
          denials: 1.5,
          usage: { inputTokens: 2.5, outputTokens: 7, costUsd: -0.2 },
        }),
      ],
      [300, end('spec#1', 'done', 200)],
      [310, journal('spec#1', 1, 'done')],
    ),
  );
  expect([summary?.calls, summary?.totals]).toEqual([
    [{ key: 'spec#1', kind: 'agent', outcome: 'done', durationMs: 200, resultPath: 'spec/call-1/result.json' }],
    { stageCalls: 1, steps: 1, toolCalls: 0, denials: 0, replays: 0, usage: { outputTokens: 7, costUsd: 0 } },
  ]);
});

test("each loop's iterations are the highest its loop:iteration and loop:exit events report, in first-seen order", () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, loopIteration('review', 1, 2)],
      [200, { type: 'loop:exit', loop: 'review', iterations: 2, max: 2, reason: 'exceeded' }],
      [300, loopIteration('fix', 1, 3)],
      [400, loopIteration('fix', 2, 3)],
      [500, runEnd('suspended', 1, { stopReason: 'interrupted', message: 'stopped during implement#2' })],
      [600, loopIteration('fix', 2, 3)],
    ),
  );
  expect(summary?.loops).toEqual({ review: { iterations: 2, max: 2 }, fix: { iterations: 2, max: 3 } });
  expect(Object.keys(summary?.loops ?? {})).toEqual(['review', 'fix']);
});

test("a route repeated with no call's journal:append between is dropped, and the same move after one is kept", () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('spec#1')],
      [200, end('spec#1', 'passed', 100)],
      [210, journal('spec#1', 1, 'passed')],
      [220, route('spec#1', 'passed', 'implement#1')],
      [300, runEnd('suspended', 1, { stopReason: 'interrupted', message: 'stopped before implement#1' })],
      [400, route('spec#1', 'passed', 'implement#1')],
      [500, start('implement#1')],
      [600, end('implement#1', 'passed', 100)],
      [610, journal('implement#1', 2, 'passed')],
      [620, route('implement#1', 'passed', 'tests#1')],
      [630, journal('tests#1', 3, 'passed')],
      [640, route('implement#1', 'passed', 'tests#1')],
    ),
  );
  expect(summary?.routes).toEqual([
    { at: 'spec#1', value: 'passed', took: 'implement#1' },
    { at: 'implement#1', value: 'passed', took: 'tests#1' },
    { at: 'implement#1', value: 'passed', took: 'tests#1' },
  ]);
});

test("a route the resume reports again after a step line of the call it took is dropped: a step's line is its call's, not a move (review R1-7)", () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('self-review#1')],
      [200, end('self-review#1', 'done', 100)],
      [210, journal('self-review#1', 1, 'done')],
      [220, route('self-review#1', 'done', 'publish#1')],
      [300, journal('publish#1/describe', 2, 'done')],
      [400, runEnd('suspended', 1, { stopReason: 'interrupted', message: 'stopped during publish#1' })],
      [500, route('self-review#1', 'done', 'publish#1')],
    ),
  );
  expect(summary?.routes).toEqual([{ at: 'self-review#1', value: 'done', took: 'publish#1' }]);
});

test('events with no run:start give no summary', () => {
  expect(summarize(stamp([100, start('spec#1')], [300, end('spec#1', 'passed', 200)]))).toBeUndefined();
});

test("a built-in intake's call is an entry of kind builtin, which no step of a call may be", () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [
        100,
        {
          type: 'intake:start',
          key: 'intake#1',
          intake: 'ticket',
          kind: 'builtin',
          origin: 'builtin',
          consumed: { source: 'run.json#/source' },
        },
      ],
      [300, produced('intake#1', 'brief.md')],
      [400, { type: 'intake:end', key: 'intake#1', outcome: 'passed', resultPath: '00-intake/call-1/result.json' }],
      [420, journal('intake#1', 1, 'passed')],
    ),
  );
  expect(summary?.calls).toEqual([
    {
      key: 'intake#1',
      kind: 'builtin',
      outcome: 'passed',
      durationMs: 300,
      files: ['brief.md'],
      resultPath: '00-intake/call-1/result.json',
    },
  ]);
  const step = { kind: 'builtin', outcome: 'passed', durationMs: 1 };
  const steps = [
    { key: 'publish#1/describe', ...step },
    { key: 'publish#1/open', ...step },
  ];
  const multiStep = { ...summary, calls: [{ key: 'publish#1', outcome: 'passed', durationMs: 2, steps }] };
  expect(validateDocument('sail.summary.v1', multiStep).map((issue) => issue.path)).toEqual([
    '/calls/0/steps/0/kind',
    '/calls/0/steps/1/kind',
  ]);
});

const OWN_INTAKE_START: NewEvent = {
  type: 'intake:start',
  key: 'intake#1',
  intake: 'groom',
  kind: 'stage',
  steps: ['fetch', 'shape'],
  origin: 'repo:.sail/workflows/groom',
  consumed: { source: 'run.json#/source' },
};
const intakeEnd = (outcome: 'done' | 'failed'): NewEvent => ({
  type: 'intake:end',
  key: 'intake#1',
  outcome,
  resultPath: '00-intake/call-1/result.json',
});

test('a repository intake of two steps is a call with both steps and no kind of its own, as a multi-step stage is', () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, OWN_INTAKE_START],
      [200, stepStart('intake#1/fetch', 1, 2, 'script')],
      [300, stepEnd('intake#1/fetch', 1, 'passed')],
      [400, stepStart('intake#1/shape', 2, 2, 'agent')],
      [900, stepEnd('intake#1/shape', 2, 'done')],
      [1000, intakeEnd('done')],
      [1010, journal('intake#1', 1, 'done')],
    ),
  );
  expect(summary?.calls).toEqual([
    {
      key: 'intake#1',
      outcome: 'done',
      durationMs: 900,
      resultPath: '00-intake/call-1/result.json',
      steps: [
        { key: 'intake#1/fetch', kind: 'script', outcome: 'passed', durationMs: 100 },
        { key: 'intake#1/shape', kind: 'agent', outcome: 'done', durationMs: 500 },
      ],
    },
  ]);
});

test('a repository intake started again after its first step ended keeps that step, as a resumed multi-step stage does', () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, OWN_INTAKE_START],
      [200, stepStart('intake#1/fetch', 1, 2, 'script')],
      [300, stepEnd('intake#1/fetch', 1, 'passed')],
      [400, runEnd('suspended', 1, { stopReason: 'interrupted' })],
      [5000, OWN_INTAKE_START],
      [5100, stepStart('intake#1/shape', 2, 2, 'agent')],
      [5600, stepEnd('intake#1/shape', 2, 'done')],
      [5700, intakeEnd('done')],
    ),
  );
  expect(summary?.calls[0]?.steps?.map((step) => step.key)).toEqual(['intake#1/fetch', 'intake#1/shape']);
});

// The run's ticket (D16): the one the intake fetched.

const INTAKE_START: NewEvent = {
  type: 'intake:start',
  key: 'intake#1',
  intake: 'ticket',
  kind: 'builtin',
  origin: 'builtin',
  consumed: { source: 'run.json#/source' },
};
const TICKET = { ticketKey: 'FAKE-1', title: 'Add a --shout flag', url: 'fake://tickets/FAKE-1' };

test("the summary names the run's ticket by its key, title and URL, from the intake's ticket:fetched, and a stream that ended before the fetch has no ticket", () => {
  const before = stamp([0, runStart()], [100, INTAKE_START]);
  expect(folded(before)).not.toHaveProperty('ticket');
  const summary = folded(stamp([0, runStart()], [100, INTAKE_START], [300, fetched('intake#1', TICKET.title)]));
  expect(summary?.ticket).toEqual(TICKET);
  // After the source, as sail.summary.v1 lists them.
  expect(Object.keys(summary ?? {}).slice(0, 6)).toEqual(['schema', 'runId', 'workflow', 'source', 'ticket', 'status']);
});

test("a later ticket:fetched under another key, with another title, leaves the summary's ticket as the intake's, and so does a second one of the intake's own", () => {
  const stream = stamp(
    [0, runStart()],
    [100, INTAKE_START],
    [300, fetched('intake#1', TICKET.title)],
    [900, start('spec#1')],
    [950, fetched('spec#1', 'A title a script fetched', 'fake://tickets/FAKE-7')],
    [990, fetched('intake#1', 'The title, edited since')],
    [1200, end('spec#1', 'passed', 300)],
  );
  expect(folded(stream)?.ticket).toEqual(TICKET);
});

test("a ticket:fetched with no key, or under a step's key alone, sets no ticket: only the intake's names the run's", () => {
  const keyless = stamp([0, runStart()], [100, fetched(undefined, 'Fetched at dispatch')]);
  expect(folded(keyless)).not.toHaveProperty('ticket');
  const script = stamp([0, runStart()], [100, start('open#1')], [200, fetched('open#1', "A script's fetch")]);
  expect(folded(script)).not.toHaveProperty('ticket');
  // The fold is the one under test: the same stream with the intake's key names the ticket.
  expect(folded(stamp([0, runStart()], [100, fetched('intake#1', 'Named')]))?.ticket?.title).toBe('Named');
});

const SOURCE_RUN = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3M';
const reusedIntake = (key: string, ticket = TICKET): NewEvent => ({
  type: 'journal:append',
  key,
  line: 1,
  outcome: 'passed',
  fromRun: SOURCE_RUN,
  ticket,
});

test("a reused intake's journal:append carrying a ticket names the run's ticket, and validates as an event", () => {
  const summary = folded(stamp([0, runStart()], [10, reusedIntake('intake#1')]));
  expect(summary?.ticket).toEqual(TICKET);
  expect(validateDocument('sail.summary.v1', summary).map(formatIssue)).toEqual([]);
  const [event] = stamp([10, reusedIntake('intake#1')]);
  expect(validateDocument('sail.event.v1', event).map(formatIssue)).toEqual([]);
});

test('a ticket on a journal:append under another key names no ticket', () => {
  expect(folded(stamp([0, runStart()], [10, reusedIntake('spec#1')]))).not.toHaveProperty('ticket');
});

test("a ticket:fetched under the intake's key before a ticketed journal:append still wins", () => {
  const other = { ticketKey: 'FAKE-9', title: 'Another', url: 'fake://tickets/FAKE-9' };
  const stream = stamp(
    [0, runStart()],
    [100, fetched('intake#1', TICKET.title)],
    [200, reusedIntake('intake#1', other)],
  );
  expect(folded(stream)?.ticket).toEqual(TICKET);
});

test('a reused call is listed where its journal:append comes, with its fromRun and no duration, and counts in no total', () => {
  const source = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3M';
  const summary = folded(
    stamp(
      [0, runStart()],
      [10, { type: 'journal:append', key: 'intake#1', line: 1, outcome: 'passed', fromRun: source }],
      [100, start('spec#1')],
      [600, end('spec#1', 'done', 480)],
      [620, journal('spec#1', 2, 'done')],
    ),
  );
  expect([summary?.calls, summary?.totals.stageCalls, summary?.totals.steps]).toEqual([
    [
      { key: 'intake#1', outcome: 'passed', durationMs: 0, fromRun: source },
      { key: 'spec#1', kind: 'script', outcome: 'done', durationMs: 480, resultPath: 'spec/call-1/result.json' },
    ],
    1,
    1,
  ]);
});

test('a group is listed once, with its keys in the order given and its duration from its all:end, though a resume reported its all:start again; its calls stay among the calls, in the order they started', () => {
  const keys = ['style#1', 'coverage#1'];
  const events = stamp(
    [0, runStart()],
    [10, { type: 'all:start', keys, running: keys }],
    [20, start('style#1', { kind: 'agent' })],
    [30, start('coverage#1', { kind: 'agent' })],
    [130, end('coverage#1', 'done', 100)],
    [140, journal('coverage#1', 1, 'done')],
    [200, runEnd('suspended', 1, { stopReason: 'interrupted' })],
    [300, { type: 'all:start', keys, running: ['style#1'] }],
    [310, start('style#1', { kind: 'agent', try: 2 })],
    [510, end('style#1', 'done', 200, 2)],
    [520, journal('style#1', 2, 'done')],
    [530, { type: 'all:end', keys, outcomes: { 'style#1': 'done', 'coverage#1': 'done' }, durationMs: 230 }],
    [600, runEnd('completed', 2)],
  );
  expect(folded(events.slice(0, 9))?.groups).toEqual([{ keys }]);
  const summary = folded(events);
  expect(summary?.groups).toEqual([{ keys, durationMs: 230 }]);
  expect(summary?.calls.map((call) => call.key)).toEqual(['style#1', 'coverage#1']);
});

test('a run from a pull request names its source by its number and head sha, and has no ticket', () => {
  const headSha = 'c'.repeat(40);
  const source = { kind: 'pr' as const, number: 12, headSha, via: 'watch' as const, forced: [] };
  const summary = folded(stamp([0, { ...runStart(), source } as NewEvent], [100, INTAKE_START]));
  expect([summary?.source, summary?.ticket]).toEqual([{ kind: 'pr', number: 12, headSha, via: 'watch' }, undefined]);
});

test("a multi-step call a resume started again between its steps keeps the steps it ended before: one call, both steps, the first step's cost", () => {
  const summary = folded(
    stamp(
      [0, runStart()],
      [100, start('publish#1', { kind: 'stage', steps: ['describe', 'open'] })],
      [200, stepStart('publish#1/describe', 1, 2, 'agent')],
      [300, session('publish#1/describe', { turns: 2, toolCalls: 1, denials: 0, usage: { costUsd: 0.25 } })],
      [310, produced('publish#1/describe', 'pr-body.md')],
      [1200, stepEnd('publish#1/describe', 1, 'done', 1, 800)],
      [1210, journal('publish#1/describe', 3, 'done')],
      [1300, runEnd('suspended', 1, { stopReason: 'interrupted' })],
      [5000, start('publish#1', { kind: 'stage', steps: ['describe', 'open'] })],
      [5100, stepStart('publish#1/open', 2, 2, 'script')],
      [5600, stepEnd('publish#1/open', 2, 'passed', 1, 300)],
      [5610, journal('publish#1/open', 4, 'passed')],
      [5700, end('publish#1', 'passed', 1100)],
      [5710, journal('publish#1', 5, 'passed')],
      [5800, runEnd('completed', 1)],
    ),
  );
  expect([summary?.calls, summary?.totals.steps]).toEqual([
    [
      {
        key: 'publish#1',
        outcome: 'passed',
        durationMs: 1100,
        costUsd: 0.25,
        files: ['pr-body.md'],
        resultPath: 'publish/call-1/result.json',
        steps: [
          {
            key: 'publish#1/describe',
            kind: 'agent',
            outcome: 'done',
            durationMs: 800,
            turns: 2,
            toolCalls: 1,
            costUsd: 0.25,
            files: ['pr-body.md'],
          },
          { key: 'publish#1/open', kind: 'script', outcome: 'passed', durationMs: 300 },
        ],
      },
    ],
    2,
  ]);
});

test("a seeded run's reused step lines add no call: its reused multi-step call is listed once, by its own line", () => {
  const source = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3M';
  const reused = (key: string, line: number, outcome: 'passed' | 'done'): [number, NewEvent] => [
    line * 10,
    { type: 'journal:append', key, line, outcome, fromRun: source },
  ];
  const summary = folded(
    stamp(
      [0, runStart()],
      reused('intake#1', 1, 'passed'),
      reused('publish#1/describe', 2, 'done'),
      reused('publish#1/open', 3, 'passed'),
      reused('publish#1', 4, 'passed'),
      [100, start('notify#1')],
      [300, end('notify#1', 'passed', 180)],
      [310, journal('notify#1', 5, 'passed')],
    ),
  );
  expect([summary?.calls.map(({ key, fromRun }) => [key, fromRun]), summary?.totals.stageCalls]).toEqual([
    [
      ['intake#1', source],
      ['publish#1', source],
      ['notify#1', undefined],
    ],
    1,
  ]);
});
