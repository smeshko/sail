import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fingerprintBindings } from '../../src/engine/fingerprint';
import type { JournalEntry } from '../../src/engine/journal';
import type { ReachedStage } from '../../src/engine/load-workflow';
import { dropStrayHalt, type ReplayEnd, replay } from '../../src/engine/replay';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import type { Emit, NewEvent } from '../../src/events/types';
import {
  agent,
  file,
  type ProducedFile,
  type Run,
  type StageDefinition,
  script,
  value,
  workflow,
  z,
} from '../../src/sdk';
import { ticket } from '../../src/sdk/intakes';

const RUN_DIR = '/runs/FAKE-1-01M3J94G5X7C627GTFB2M111ZT';
const INPUT = { ticketKey: 'FAKE-1', title: 'a ticket' };

/** A run's journaled `intake#1` whose output, the run's input, is `output`. */
const intakeOf = (output: unknown): JournalEntry => ({
  seq: 1,
  key: 'intake#1',
  stage: 'intake',
  call: 1,
  outcome: 'passed',
  output,
  reason: null,
  files: { 'ticket.json': '00-intake/call-1/out/ticket.json', 'brief.md': '00-intake/call-1/out/brief.md' },
  resultPath: '00-intake/call-1/result.json',
  recordedAt: '2026-10-06T09:00:00.000Z',
});

const Report = z.object({ ok: z.boolean() });
const a = script('a', { run: './run.sh', produces: { 'r.txt': 'file' }, output: Report });
const b = script('b', { run: './run.sh', consumes: { report: file('r.txt') }, output: Report });
const c = script('c', {
  run: './run.sh',
  consumes: { data: value(z.unknown()), extra: value(z.string()).optional() },
  output: Report,
});
const planner = agent('planner', {
  prompt: './prompt.md',
  output: Report,
  permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
  budget: { maxTurns: 1, maxUsd: 1, maxMinutes: 1 },
});
const implement = script('implement', {
  run: './run.sh',
  consumes: { feedback: value(Report).optional() },
  output: Report,
});
const tests = script('tests', { run: './run.sh', output: Report });
/** A stage the workflow reaches at run time but its roster doesn't hold. */
const stray = script('stray', { run: './run.sh', output: Report });

const reached = (definition: StageDefinition): ReachedStage => ({
  definition,
  dir: `/repo/.sail/stages/${definition.name}`,
  module: {},
});
const STAGES = [a, b, c, planner, implement, tests].map(reached);

type Body = (run: Run<typeof ticket.output>) => Promise<unknown>;

/**
 * Replays a workflow whose body is `body` against `entries`, beside a journaled intake whose output is `INPUT`. Its
 * events go to `emit` when one is given.
 */
function replayed(body: Body, entries: JournalEntry[] = [], emit?: Emit): Promise<ReplayEnd> {
  const flow = workflow('flow', { intake: ticket }, body);
  const options = { workflow: flow as never, stages: STAGES, entries, runDir: RUN_DIR, intake: intakeOf(INPUT) };
  return replay(emit === undefined ? options : { ...options, emit });
}

/** A journaled call of `key`, `stage#call`, in stage directory `index`. */
function entry(key: string, outcome: JournalEntry['outcome'], fields: Partial<JournalEntry> = {}): JournalEntry {
  const [stage = '', call = '1'] = key.split('#');
  const index = { a: 1, b: 2, c: 2, planner: 3, implement: 1, tests: 2 }[stage] ?? 9;
  return {
    seq: 1,
    key,
    stage,
    call: Number(call),
    outcome,
    output: outcome === 'blocked' || outcome === 'error' ? null : { ok: true },
    reason: null,
    files: {},
    resultPath: `0${index}-${stage}/call-${call}/result.json`,
    recordedAt: '2026-09-27T09:00:00.000Z',
    ...fields,
  };
}

type Failed = Extract<ReplayEnd, { kind: 'failed' }>;
const failed = (stopReason: Failed['stopReason'], message: string): ReplayEnd => ({
  kind: 'failed',
  stopReason,
  message,
});

/** Gives abandoned continuations a chance to run, so a test can show they never do. */
const settle = () => Bun.sleep(5);

test("with an empty journal the first run.stage() is the replay's end, and the workflow never resumes", async () => {
  const seen = { after: false, caught: false, finally: false };
  const end = await replayed(async (run) => {
    try {
      await run.stage(a);
      seen.after = true;
    } catch {
      seen.caught = true;
    } finally {
      seen.finally = true;
    }
    return 'returned';
  });
  await settle();

  expect(end).toEqual({
    kind: 'call',
    call: {
      key: 'a#1',
      stage: 'a',
      call: 1,
      stageIndex: 1,
      definition: a,
      stageFile: '/repo/.sail/stages/a/stage.ts',
      supplied: {},
      fingerprints: {},
    },
  });
  if (end.kind !== 'call') throw new Error('a call');
  expect(end.call.definition).toBe(a);
  expect(seen).toEqual({ after: false, caught: false, finally: false });
});

test("a journaled call returns its recorded result, and its files bind as the run's files", async () => {
  const entries = [entry('a#1', 'passed', { output: { ok: false }, files: { 'r.txt': '01-a/call-1/r.txt' } })];
  let result: unknown;
  let produced: ProducedFile | undefined;
  const end = await replayed(async (run) => {
    const r = await run.stage(a);
    result = r;
    produced = r.files['r.txt'];
    await run.stage(b, { report: r.files['r.txt'] });
  }, entries);

  expect(result).toEqual({ outcome: 'passed', output: { ok: false }, files: { 'r.txt': { name: 'r.txt' } } });
  expect(Object.isFrozen(produced)).toBe(true);
  expect(end).toMatchObject({
    kind: 'call',
    call: {
      key: 'b#1',
      stageIndex: 2,
      supplied: {
        report: { kind: 'file', path: join(RUN_DIR, '01-a/call-1/r.txt'), from: '01-a/call-1/r.txt' },
      },
    },
  });
});

test("a value binding records where it came from: a call's output, or the workflow", async () => {
  const entries = [entry('a#1', 'passed')];
  const fromOutput = await replayed(async (run) => {
    const r = await run.stage(a);
    await run.stage(c, { data: r.output, extra: undefined });
  }, entries);
  expect(fromOutput).toMatchObject({
    call: { supplied: { data: { kind: 'value', value: { ok: true }, from: '01-a/call-1/result.json#/output' } } },
  });
  if (fromOutput.kind !== 'call') throw new Error('a call');
  expect(Object.keys(fromOutput.call.supplied)).toEqual(['data']);

  const literal = await replayed(async (run) => {
    await run.stage(c, { data: [1, 2], extra: 'x' });
  });
  expect(literal).toMatchObject({
    call: {
      supplied: {
        data: { kind: 'value', value: [1, 2], from: 'workflow' },
        extra: { kind: 'value', value: 'x', from: 'workflow' },
      },
    },
  });
});

test('a pending call carries one hash per supplied binding, a value by its canonical JSON and a file by its path', async () => {
  const entries = [entry('a#1', 'passed', { files: { 'r.txt': '01-a/call-1/r.txt' } })];
  const end = await replayed(async (run) => {
    const r = await run.stage(a);
    await run.stage(c, { data: { y: 1, x: [2] }, extra: undefined });
    await run.stage(b, { report: r.files['r.txt'] });
  }, entries);
  if (end.kind !== 'call') throw new Error('a call');
  expect(end.call.fingerprints).toEqual(
    fingerprintBindings({ data: { kind: 'value', value: { x: [2], y: 1 }, from: '' } }),
  );
  expect(end.call.fingerprints.data).toMatch(/^[0-9a-f]{16}$/);

  const consumer = await replayed(async (run) => {
    const r = await run.stage(a);
    await run.stage(b, { report: r.files['r.txt'] });
  }, entries);
  if (consumer.kind !== 'call') throw new Error('a call');
  expect(consumer.call.fingerprints).toEqual(
    fingerprintBindings({
      report: { kind: 'file', path: join(RUN_DIR, '01-a/call-1/r.txt'), from: '01-a/call-1/r.txt' },
    }),
  );
});

test('a value canonical JSON cannot encode fails the call as workflow_failed, naming the binding', async () => {
  const end = await replayed(async (run) => {
    await run.stage(c, { data: 1n });
  });
  if (end.kind !== 'failed') throw new Error('a failure');
  expect(end.stopReason).toBe('workflow_failed');
  expect(end.message).toStartWith("c#1 can't run: 'data' can't be fingerprinted: ");
});

test('a value binding not declared by the stage passes through for callProblems to name', async () => {
  const end = await replayed(async (run) => {
    await run.stage(a, { surprise: 1 } as never);
  });
  expect(end).toMatchObject({ call: { supplied: { surprise: { kind: 'value', value: 1, from: 'workflow' } } } });
});

test('a stage called again is its next call, in the directory its first call numbered', async () => {
  const entries = [entry('a#1', 'passed'), entry('c#1', 'passed')];
  const end = await replayed(async (run) => {
    await run.stage(a);
    await run.stage(c, { data: 1 });
    await run.stage(a);
  }, entries);
  expect(end).toMatchObject({ kind: 'call', call: { key: 'a#2', stage: 'a', call: 2, stageIndex: 1 } });
});

test('a workflow that returns once every call is journaled completes with its value', async () => {
  const end = await replayed(
    async (run) => {
      const r = await run.stage(a);
      return { summary: r.output.ok };
    },
    [entry('a#1', 'passed')],
  );
  expect(end).toEqual({ kind: 'completed', result: { summary: true } });
});

test('run.input and a journaled output are frozen, so a workflow that changes either fails the run', async () => {
  const input = { ticketKey: 'FAKE-1', title: 'a ticket', url: 'fake://tickets/FAKE-1', acceptanceCriteria: ['one'] };
  const flow = workflow('flow', { intake: ticket }, async (run) => {
    (run.input.acceptanceCriteria as string[]).push('two');
  });
  const changesInput = await replay({
    workflow: flow as never,
    stages: STAGES,
    entries: [],
    runDir: RUN_DIR,
    intake: intakeOf(input),
  });
  const threw = failed('workflow_failed', expect.stringMatching(/^workflow threw: /));
  expect(changesInput).toEqual(threw);
  expect(input.acceptanceCriteria).toEqual(['one']);

  const changesOutput = await replayed(
    async (run) => {
      const result = await run.stage(a);
      (result.output as { ok: boolean }).ok = false;
    },
    [entry('a#1', 'passed')],
  );
  expect(changesOutput).toEqual(threw);
});

test('run.fail() ends the replay, even when the workflow catches it and asks for another call', async () => {
  let after = false;
  const end = await replayed(async (run) => {
    try {
      run.fail('why');
    } catch {
      await run.stage(a);
      after = true;
    }
  });
  await settle();
  expect(end).toEqual(failed('workflow_failed', 'why'));
  expect(after).toBe(false);
});

// test/cli/main.test.ts shows it in a process of its own: bun test fails a test on any unhandled rejection.
test('a replay has the process drop a stray Halt, and throw any other unhandled rejection on', async () => {
  let halt: unknown;
  await replayed(async (run) => {
    try {
      run.fail('why');
    } catch (error) {
      halt = error;
    }
  });
  expect(process.listeners('unhandledRejection')).toContain(dropStrayHalt);
  expect(() => dropStrayHalt(halt)).not.toThrow();
  const bug = new Error('a bug');
  expect(() => dropStrayHalt(bug)).toThrow(bug);
});

test.each<[string, unknown, string]>([
  ['an Error', new Error('boom'), 'workflow threw: boom'],
  ['anything else', 'plain', 'workflow threw: plain'],
])('a workflow that throws %s fails the run', async (_, thrown, message) => {
  const end = await replayed(async () => {
    throw thrown;
  });
  expect(end).toEqual(failed('workflow_failed', message));
});

test('an error ends the run with stage_error, unless the call asks for it', async () => {
  const entries = [entry('a#1', 'error', { reason: "'r.txt' was not produced in $STAGE_OUT" })];
  const unhandled = await replayed(async (run) => {
    await run.stage(a);
  }, entries);
  expect(unhandled).toEqual(failed('stage_error', "a#1 ended in error: 'r.txt' was not produced in $STAGE_OUT"));

  const routed = await replayed(async (run) => {
    const r = await run.stage(a, {}, { onError: 'return' });
    if (r.outcome === 'error') return `routed: ${r.reason}`;
    return 'passed';
  }, entries);
  expect(routed).toEqual({ kind: 'completed', result: "routed: 'r.txt' was not produced in $STAGE_OUT" });
});

test('a blocked call reaches the workflow with its reason', async () => {
  let result: unknown;
  const end = await replayed(
    async (run) => {
      result = await run.stage(planner);
      return 'done';
    },
    [entry('planner#1', 'blocked', { reason: 'no ticket' })],
  );
  expect(result).toEqual({ outcome: 'blocked', reason: 'no ticket' });
  expect(end).toEqual({ kind: 'completed', result: 'done' });
});

test('a replay that diverges from the journal fails with determinism_violation, naming both keys', async () => {
  const asked = await replayed(
    async (run) => {
      await run.stage(c, { data: 1 });
    },
    [entry('a#1', 'passed')],
  );
  expect(asked).toEqual(failed('determinism_violation', "the workflow asked for 'c#1' where the journal has 'a#1'"));

  const ended = await replayed(
    async (run) => {
      await run.stage(a);
      return 'early';
    },
    [entry('a#1', 'passed'), entry('c#1', 'passed')],
  );
  expect(ended).toEqual(failed('determinism_violation', "the workflow ended where the journal has 'c#1'"));

  const failedEarly = await replayed(
    async (run) => {
      run.fail('early');
    },
    [entry('a#1', 'passed')],
  );
  expect(failedEarly).toEqual(failed('determinism_violation', "the workflow ended where the journal has 'a#1'"));
});

test("a call that can't start fails the run with workflow_failed, naming why", async () => {
  const outside = await replayed(async (run) => {
    await run.stage(stray);
  });
  expect(outside).toEqual(
    failed('workflow_failed', "stray#1 can't run: 'stray' isn't a stage the workflow's roster holds"),
  );

  const handBuilt = await replayed(async (run) => {
    await run.stage(b, { report: { name: 'r.txt' } as ProducedFile });
  });
  expect(handBuilt).toEqual(failed('workflow_failed', "b#1 can't run: 'report' needs a file a call produced"));

  const notAnObject = await replayed(async (run) => {
    await run.stage(c, null as never);
  });
  expect(notAnObject).toEqual(failed('workflow_failed', "c#1 can't run: its bindings must be an object"));

  const notAStage = await replayed(async (run) => {
    await run.stage(undefined as never);
  });
  expect(notAStage).toEqual(failed('workflow_failed', 'run.stage() was given undefined, not a stage'));
});

test('calls issued together run one per replay, in the order they were requested', async () => {
  const end = await replayed(async (run) => {
    await Promise.all([run.stage(c, { data: 1 }), run.stage(a)]);
  });
  expect(end).toMatchObject({ kind: 'call', call: { key: 'c#1' } });

  const next = await replayed(
    async (run) => {
      await Promise.all([run.stage(c, { data: 1 }), run.stage(a)]);
    },
    [entry('c#1', 'passed')],
  );
  expect(next).toMatchObject({ kind: 'call', call: { key: 'a#1', stageIndex: 2 } });
});

test("an exception inside sail rejects the replay, and never reaches the workflow's catch", async () => {
  let caught = false;
  const replaying = replayed(
    async (run) => {
      try {
        await run.stage(a);
      } catch {
        caught = true;
      }
    },
    [entry('a#1', 'passed', { files: null as never })],
  );
  await expect(replaying).rejects.toThrow(TypeError);
  await settle();
  expect(caught).toBe(false);
});

test("a failed pass hands its parsed feedback to the next pass, which binds it as the failed call's output", async () => {
  const entries = [entry('implement#1', 'passed'), entry('tests#1', 'failed', { output: { ok: false, noise: 1 } })];
  const previous: unknown[] = [];
  const end = await replayed(async (run) => {
    for (const iteration of run.loop('fix', { max: 3, feedback: Report })) {
      previous.push(iteration.previous);
      await run.stage(implement, { feedback: iteration.previous });
      const t = await run.stage(tests);
      if (t.outcome === 'failed') {
        iteration.fail(t.output);
        continue;
      }
      break;
    }
  }, entries);

  expect(previous).toEqual([undefined, { ok: false }]);
  expect(Object.isFrozen(previous[1])).toBe(true);
  expect(end).toMatchObject({
    kind: 'call',
    call: {
      key: 'implement#2',
      stageIndex: 1,
      supplied: { feedback: { kind: 'value', value: { ok: false }, from: '02-tests/call-1/result.json#/output' } },
    },
  });
});

test('asking for the pass after max fails the run, even when the workflow catches it', async () => {
  const entries = [entry('a#1', 'passed'), entry('a#2', 'passed')];
  let after = false;
  const end = await replayed(async (run) => {
    try {
      for (const iteration of run.loop('fix', { max: 2, feedback: Report })) {
        const r = await run.stage(a);
        iteration.fail(r.output);
      }
    } catch {
      after = true;
      return 'swallowed';
    }
    return 'looped';
  }, entries);
  expect(end).toEqual(failed('workflow_failed', 'loop "fix" exceeded 2'));
  expect(after).toBe(true);
});

test('a pass that neither fails nor breaks runs again, with no feedback', async () => {
  const previous: unknown[] = [];
  const end = await replayed(
    async (run) => {
      for (const iteration of run.loop('fix', { max: 3, feedback: Report })) {
        previous.push(iteration.previous);
        await run.stage(a);
      }
    },
    [entry('a#1', 'passed')],
  );
  expect(previous).toEqual([undefined, undefined]);
  expect(end).toMatchObject({ kind: 'call', call: { key: 'a#2' } });
});

test('break ends the loop, and the workflow goes on past it', async () => {
  const end = await replayed(
    async (run) => {
      for (const _ of run.loop('fix', { max: 3 })) {
        await run.stage(a);
        break;
      }
      await run.stage(c, { data: 1 });
    },
    [entry('a#1', 'passed')],
  );
  expect(end).toMatchObject({ kind: 'call', call: { key: 'c#1' } });
});

test('a loop without feedback carries nothing forward, and still stops at max', async () => {
  const previous: unknown[] = [];
  const end = await replayed(async (run) => {
    for (const iteration of run.loop('settle', { max: 2 })) {
      previous.push(iteration.previous);
      iteration.fail();
    }
  });
  expect(previous).toEqual([undefined, undefined]);
  expect(end).toEqual(failed('workflow_failed', 'loop "settle" exceeded 2'));
});

test('a loop that is misused fails the run, naming the loop', async () => {
  const rejected = await replayed(async (run) => {
    for (const iteration of run.loop('fix', { max: 3, feedback: Report })) {
      iteration.fail({ verdict: 'flaky' } as never);
    }
  });
  expect(rejected).toMatchObject({ kind: 'failed', stopReason: 'workflow_failed' });
  if (rejected.kind !== 'failed') throw new Error('failed');
  expect(rejected.message).toStartWith(`loop "fix" feedback doesn't match its schema:\n`);
  expect(rejected.message).toContain('ok');

  const twice = await replayed(async (run) => {
    for (const _ of run.loop('fix', { max: 1 })) break;
    for (const _ of run.loop('fix', { max: 1 })) break;
  });
  expect(twice).toEqual(failed('workflow_failed', 'loop "fix" is started twice in one replay'));

  for (const max of [0, 1.5, undefined]) {
    const bounded = await replayed(async (run) => {
      for (const _ of run.loop('fix', { max } as never)) break;
    });
    expect(bounded).toEqual(failed('workflow_failed', 'loop "fix" needs a whole max of at least 1'));
  }
});

test('a loop the workflow keeps using after the run ended stops at its next pass', async () => {
  let passes = 0;
  const end = await replayed(async (run) => {
    for (const _ of run.loop('fix', { max: 3 })) {
      passes++;
      try {
        run.fail('why');
      } catch {}
    }
  });
  expect(end).toEqual(failed('workflow_failed', 'why'));
  expect(passes).toBe(1);
});

test("an exception inside a loop's methods rejects the replay", async () => {
  const replaying = replayed(async (run) => {
    for (const iteration of run.loop('fix', { max: 3, feedback: {} as never })) {
      try {
        const fail = iteration.fail as (feedback: unknown) => void;
        fail({ ok: true });
      } catch {}
    }
  });
  await expect(replaying).rejects.toThrow(TypeError);
});

/** An emitter that keeps every event it is given. */
function collect(): { events: NewEvent[]; emit: Emit } {
  const events: NewEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

/** Checks each event against sail.event.v1, stamped as the bus would stamp it. */
function checkStamped(events: readonly NewEvent[]): void {
  const stamped = events.map((event, i) => ({
    seq: i + 1,
    ts: '2026-09-28T09:00:00.000Z',
    runId: 'FAKE-1-01M3J94G5X7C627GTFB2M111ZT',
    ...event,
  }));
  expect(stamped.flatMap((event) => validateDocument('sail.event.v1', event)).map(formatIssue)).toEqual([]);
}

/**
 * `a`, then the fix loop of `implement`, fed the last pass's feedback, and `tests`: a failed run of tests fails the pass
 * with its output, a passing one breaks. Then `c`.
 */
const fixLoop =
  (feedback: (output: { ok: boolean }) => unknown = (output) => output): Body =>
  async (run) => {
    await run.stage(a);
    for (const iteration of run.loop('fix', { max: 3, feedback: Report })) {
      await run.stage(implement, { feedback: iteration.previous });
      const t = await run.stage(tests);
      if (t.outcome === 'failed') {
        iteration.fail(feedback(t.output) as never);
        continue;
      }
      break;
    }
    await run.stage(c, { data: 1 });
    return 'done';
  };

/** The fix loop's journal up to and including `last`: tests fail on the first pass and pass on the second. */
function journalTo(last: string): JournalEntry[] {
  const all = [
    entry('a#1', 'passed'),
    entry('implement#1', 'passed'),
    entry('tests#1', 'failed', { output: { ok: false } }),
    entry('implement#2', 'passed'),
    entry('tests#2', 'passed'),
    entry('c#1', 'passed'),
  ];
  return all.slice(0, all.findIndex((each) => each.key === last) + 1);
}

test("a first pass past the journal's end reports its iteration, then the route into it", async () => {
  const { events, emit } = collect();
  const end = await replayed(fixLoop(), journalTo('a#1'), emit);
  expect(end).toMatchObject({ kind: 'call', call: { key: 'implement#1' } });
  expect(events).toEqual([
    { type: 'loop:iteration', loop: 'fix', iteration: 1, max: 3 },
    { type: 'workflow:route', at: 'a#1', value: 'passed', took: 'implement#1' },
  ]);
  checkStamped(events);
});

test('a pass after a failed one names the output its feedback came from, and the route records the failure', async () => {
  const { events, emit } = collect();
  await replayed(fixLoop(), journalTo('tests#1'), emit);
  expect(events).toEqual([
    {
      type: 'loop:iteration',
      loop: 'fix',
      iteration: 2,
      max: 3,
      feedback: { from: '02-tests/call-1/result.json#/output' },
    },
    { type: 'workflow:route', at: 'tests#1', value: 'failed', took: 'implement#2' },
  ]);
  checkStamped(events);
});

test('feedback the workflow builds itself comes from the workflow', async () => {
  const { events, emit } = collect();
  await replayed(
    fixLoop(() => ({ ok: false })),
    journalTo('tests#1'),
    emit,
  );
  expect(events[0]).toEqual({
    type: 'loop:iteration',
    loop: 'fix',
    iteration: 2,
    max: 3,
    feedback: { from: 'workflow' },
  });
});

test('moves the journal already holds are not reported again', async () => {
  const { events, emit } = collect();
  await replayed(fixLoop(), journalTo('implement#2'), emit);
  expect(events).toEqual([{ type: 'workflow:route', at: 'implement#2', value: 'passed', took: 'tests#2' }]);
});

test("break reports the loop's exit at the workflow's next move, before its route", async () => {
  const { events, emit } = collect();
  const end = await replayed(fixLoop(), journalTo('tests#2'), emit);
  console.log(JSON.stringify(events));
  expect(end).toMatchObject({ kind: 'call', call: { key: 'c#1' } });
  expect(events).toEqual([
    { type: 'loop:exit', loop: 'fix', iterations: 2, max: 3, reason: 'break' },
    { type: 'workflow:route', at: 'tests#2', value: 'passed', took: 'c#1' },
  ]);
  checkStamped(events);
});

test('leaving nested loops at once reports each exit, inner first, before the route', async () => {
  const events = await reported(
    async (run) => {
      await run.stage(a);
      for (const _outer of run.loop('outer', { max: 2 })) {
        for (const _inner of run.loop('inner', { max: 2 })) {
          await run.stage(tests);
          break;
        }
        return 'done';
      }
    },
    [entry('a#1', 'passed'), entry('tests#1', 'passed')],
  );
  expect(events).toEqual([
    { type: 'loop:exit', loop: 'inner', iterations: 1, max: 2, reason: 'break' },
    { type: 'loop:exit', loop: 'outer', iterations: 1, max: 2, reason: 'break' },
    { type: 'workflow:route', at: 'tests#1', value: 'passed', took: 'end' },
  ]);
  checkStamped(events);
});

test('a throw out of a loop body is not an exit', async () => {
  const { events, emit } = collect();
  const end = await replayed(
    async (run) => {
      await run.stage(a);
      for (const _ of run.loop('fix', { max: 3 })) throw new Error('boom');
    },
    [entry('a#1', 'passed')],
    emit,
  );
  expect(end).toEqual(failed('workflow_failed', 'workflow threw: boom'));
  expect(events).toEqual([{ type: 'loop:iteration', loop: 'fix', iteration: 1, max: 3 }]);
});

test('asking for the pass after max reports the loop exceeded, and no route', async () => {
  const { events, emit } = collect();
  const end = await replayed(
    async (run) => {
      for (const iteration of run.loop('fix', { max: 2, feedback: Report })) {
        const r = await run.stage(a);
        iteration.fail(r.output);
      }
    },
    [entry('a#1', 'passed'), entry('a#2', 'passed')],
    emit,
  );
  expect(end).toEqual(failed('workflow_failed', 'loop "fix" exceeded 2'));
  expect(events).toEqual([{ type: 'loop:exit', loop: 'fix', iterations: 2, max: 2, reason: 'exceeded' }]);
  checkStamped(events);
});

/** The events a replay of `body` against `entries` reports. */
async function reported(body: Body, entries: JournalEntry[]): Promise<NewEvent[]> {
  const { events, emit } = collect();
  await replayed(body, entries, emit);
  return events;
}

test('a route is reported for the moves the workflow made: its end, run.fail(), never an end the engine made', async () => {
  const after = [entry('a#1', 'passed')];
  const returns: Body = async (run) => {
    await run.stage(a);
    return 'done';
  };
  const fails: Body = async (run) => {
    await run.stage(a);
    run.fail('why');
  };
  expect(await reported(returns, after)).toEqual([{ type: 'workflow:route', at: 'a#1', value: 'passed', took: 'end' }]);
  expect(await reported(fails, after)).toEqual([{ type: 'workflow:route', at: 'a#1', value: 'passed', took: 'fail' }]);

  // With no journaled call there is no route to report.
  expect(await reported(async () => 'done', [])).toEqual([]);
  expect(await reported(async (run) => run.fail('why'), [])).toEqual([]);

  // A call that can't start, an unhandled error and a diverging replay are the engine's ends, not the workflow's.
  const loopThen =
    (next: (run: Run<typeof ticket.output>) => Promise<unknown>): Body =>
    async (run) => {
      await run.stage(a);
      for (const _ of run.loop('fix', { max: 3 })) await next(run);
    };
  const iteration = { type: 'loop:iteration', loop: 'fix', iteration: 1, max: 3 } as const;
  expect(
    await reported(
      loopThen((run) => run.stage(b, { report: { name: 'r.txt' } as ProducedFile })),
      after,
    ),
  ).toEqual([iteration]);
  expect(
    await reported(
      loopThen((run) => run.stage(stray)),
      after,
    ),
  ).toEqual([iteration]);
  expect(await reported(returns, [entry('a#1', 'error', { reason: 'boom' })])).toEqual([]);
  expect(await reported(returns, [entry('a#1', 'passed'), entry('c#1', 'passed')])).toEqual([]);
});

// The journaled intake (D6): `run.input` and `run.intake.files` come from the `intake#1` entry, given beside the
// stage entries.

const INTAKE = intakeOf({
  ticketKey: 'FAKE-1',
  title: 'a ticket',
  url: 'fake://tickets/FAKE-1',
  acceptanceCriteria: ['one'],
  labels: [],
  links: [],
  attachments: [],
});
/** The same intake journaled from its second try. */
const LATER_TRY: JournalEntry = {
  ...INTAKE,
  files: { 'ticket.json': '00-intake/call-1/try-2/out/ticket.json', 'brief.md': '00-intake/call-1/try-2/out/brief.md' },
  resultPath: '00-intake/call-1/try-2/result.json',
};

type TicketBody = (run: Run<typeof ticket.output, typeof ticket.produces>) => Promise<unknown>;

/** Replays a workflow whose body is `body` against the journaled `intake` and the stage `entries`. */
function replayedFrom(
  body: TicketBody,
  intake: JournalEntry = INTAKE,
  entries: JournalEntry[] = [],
  emit?: Emit,
): Promise<ReplayEnd> {
  const flow = workflow('flow', { intake: ticket }, body);
  const options = {
    workflow: flow as never,
    stages: STAGES,
    entries,
    runDir: RUN_DIR,
    intake: structuredClone(intake),
  };
  return replay(emit === undefined ? options : { ...options, emit });
}

test('given the journaled intake, run.input is its output, frozen all the way down: a workflow that changes it fails the run', async () => {
  let seen: unknown;
  const end = await replayedFrom(async (run) => {
    seen = run.input;
    (run.input.acceptanceCriteria as string[]).push('two');
  });
  expect(seen).toEqual(INTAKE.output);
  expect(Object.isFrozen(seen)).toBe(true);
  expect(end).toEqual(failed('workflow_failed', expect.stringMatching(/^workflow threw: /)));
  expect((seen as { acceptanceCriteria: string[] }).acceptanceCriteria).toEqual(['one']);
});

test("run.intake.files holds a handle per file the entry names, which binds as the intake's file; the first request is stage 1 and reports no route, and an object that only looks like a handle is refused", async () => {
  const { events, emit } = collect();
  let names: string[] = [];
  const bound = await replayedFrom(
    async (run) => {
      names = Object.keys(run.intake.files);
      await run.stage(b, { report: run.intake.files['brief.md'] });
    },
    INTAKE,
    [],
    emit,
  );
  expect(names).toEqual(['ticket.json', 'brief.md']);
  expect(bound).toMatchObject({
    kind: 'call',
    call: {
      key: 'b#1',
      stageIndex: 1,
      supplied: {
        report: {
          kind: 'file',
          path: join(RUN_DIR, '00-intake/call-1/out/brief.md'),
          from: '00-intake/call-1/out/brief.md',
        },
      },
    },
  });
  expect(events).toEqual([]);

  const forged = await replayedFrom(async (run) => {
    await run.stage(b, { report: { name: 'brief.md' } as ProducedFile });
  });
  expect(forged).toEqual(failed('workflow_failed', "b#1 can't run: 'report' needs a file a call produced"));
});

test("run.input supplied to a value binding records the intake's result, and a value taken out of it records the workflow", async () => {
  const whole = await replayedFrom(async (run) => {
    await run.stage(c, { data: run.input });
  });
  expect(whole).toMatchObject({
    call: { supplied: { data: { kind: 'value', value: INTAKE.output, from: '00-intake/call-1/result.json#/output' } } },
  });
  const part = await replayedFrom(async (run) => {
    await run.stage(c, { data: run.input.title, extra: run.input.ticketKey });
  });
  expect(part).toMatchObject({
    call: {
      supplied: {
        data: { kind: 'value', value: 'a ticket', from: 'workflow' },
        extra: { kind: 'value', value: 'FAKE-1', from: 'workflow' },
      },
    },
  });
});

test("an entry journaled from a later try gives handles and provenance under that try's directory", async () => {
  const file = await replayedFrom(async (run) => {
    await run.stage(b, { report: run.intake.files['brief.md'] });
  }, LATER_TRY);
  const from = '00-intake/call-1/try-2/out/brief.md';
  expect(file).toMatchObject({ call: { supplied: { report: { kind: 'file', path: join(RUN_DIR, from), from } } } });
  const value = await replayedFrom(async (run) => {
    await run.stage(c, { data: run.input });
  }, LATER_TRY);
  expect(value).toMatchObject({
    call: { supplied: { data: { from: '00-intake/call-1/try-2/result.json#/output' } } },
  });
});

test("an input that is not an object still records the intake's result", async () => {
  const end = await replayedFrom(
    async (run) => {
      await run.stage(c, { data: run.input });
    },
    { ...INTAKE, output: 'the whole input' },
  );
  expect(end).toMatchObject({
    call: { supplied: { data: { value: 'the whole input', from: '00-intake/call-1/result.json#/output' } } },
  });
});

test("a loop that fails a pass with run.input names the intake's result as where its feedback came from, also once the feedback's schema has parsed it into a new object", async () => {
  const { events, emit } = collect();
  const end = await replayedFrom(
    async (run) => {
      for (const iteration of run.loop('fix', { max: 2, feedback: z.object({ ticketKey: z.string() }) })) {
        if (iteration.previous === undefined) {
          iteration.fail(run.input);
          continue;
        }
        await run.stage(c, { data: iteration.previous });
      }
    },
    INTAKE,
    [],
    emit,
  );
  const from = '00-intake/call-1/result.json#/output';
  expect(events).toEqual([
    { type: 'loop:iteration', loop: 'fix', iteration: 1, max: 2 },
    { type: 'loop:iteration', loop: 'fix', iteration: 2, max: 2, feedback: { from } },
  ]);
  expect(end).toMatchObject({ call: { key: 'c#1', supplied: { data: { value: { ticketKey: 'FAKE-1' }, from } } } });
  checkStamped(events);
});

// run.all(): a group keyed in the order given, its journaled calls handed back in that order, and the guard over its
// whole key sequence. Its lines carry the group's keys, and are journaled in the order its calls completed.

const GROUP = ['a#1', 'tests#1', 'a#2'];
/** A journaled call of the group `GROUP`, or of `group`, at line `seq`. */
const member = (key: string, seq: number, outcome: JournalEntry['outcome'] = 'passed', group = GROUP) =>
  entry(key, outcome, { seq, group, output: { ok: outcome === 'passed' } });
/** The group `[a, tests, a]`, as a workflow asks for it. */
const trio = (run: Run<typeof ticket.output>) => run.all([[a], [tests], [a]]);
const pendingOf = (key: string, stage: StageDefinition, call: number, stageIndex: number) => ({
  key,
  stage: stage.name,
  call,
  stageIndex,
  definition: stage,
  stageFile: `/repo/.sail/stages/${stage.name}/stage.ts`,
  supplied: {},
  fingerprints: {},
  group: GROUP,
});

test('a fresh group keys its calls in the order given before any runs, the same stage twice as two calls, and ends the replay as one group end', async () => {
  const seen = { after: false };
  const end = await replayed(async (run) => {
    await trio(run);
    seen.after = true;
  });
  await settle();
  expect(end).toEqual({
    kind: 'group',
    keys: GROUP,
    calls: [pendingOf('a#1', a, 1, 1), pendingOf('tests#1', tests, 1, 2), pendingOf('a#2', a, 2, 1)],
  });
  expect(seen.after).toBe(false);
});

test('a group whose every call is journaled, in the order they completed, hands back its results in the order given, and the next call is keyed after it', async () => {
  let outcomes: string[] = [];
  const end = await replayed(
    async (run) => {
      const results = await trio(run);
      outcomes = results.map((result) => result.outcome);
      await run.stage(c, { data: 1 });
    },
    [member('tests#1', 1, 'failed'), member('a#2', 2, 'failed'), member('a#1', 3, 'passed')],
  );
  expect(outcomes).toEqual(['passed', 'failed', 'failed']);
  expect(end).toMatchObject({ kind: 'call', call: { key: 'c#1', stageIndex: 3 } });
});

test("a group with calls left ends the replay with only those, and reports no route into it; a move into a fresh group reports one, taking the group's first key", async () => {
  const events: NewEvent[] = [];
  const left = await replayed(
    async (run) => {
      await run.stage(c, { data: 1 });
      await trio(run);
    },
    [entry('c#1', 'passed', { seq: 1 }), member('tests#1', 2)],
    (event) => events.push(event),
  );
  expect(left).toEqual({ kind: 'group', keys: GROUP, calls: [pendingOf('a#1', a, 1, 2), pendingOf('a#2', a, 2, 2)] });
  expect(events).toEqual([]);

  const fresh = await replayed(
    async (run) => {
      await run.stage(c, { data: 1 });
      await trio(run);
    },
    [entry('c#1', 'passed', { seq: 1 })],
    (event) => events.push(event),
  );
  expect(fresh).toMatchObject({ kind: 'group', keys: GROUP });
  expect(events).toEqual([{ type: 'workflow:route', at: 'c#1', value: 'passed', took: 'a#1' }]);
});

test.each<[string, Body, JournalEntry[], string]>([
  [
    'a reordered group',
    (run) => run.all([[tests], [a]]),
    [member('a#1', 1, 'passed', ['a#1', 'tests#1'])],
    'the workflow asked for the group [tests#1, a#1] where the journal has the group [a#1, tests#1]',
  ],
  [
    'a group where the journal has a plain call',
    (run) => run.all([[a], [tests]]),
    [entry('a#1', 'passed')],
    "the workflow asked for the group [a#1, tests#1] where the journal has 'a#1'",
  ],
  [
    'a plain call where the journal has a group',
    (run) => run.stage(a),
    [member('a#1', 1, 'passed', ['a#1', 'tests#1'])],
    "the workflow asked for 'a#1' where the journal has the group [a#1, tests#1]",
  ],
  [
    'a group whose size changed',
    (run) => run.all([[a], [tests], [c, { data: 1 }]]),
    [member('a#1', 1, 'passed', ['a#1', 'tests#1'])],
    'the workflow asked for the group [a#1, tests#1, c#1] where the journal has the group [a#1, tests#1]',
  ],
  [
    'an entry after an unfinished group',
    (run) => run.all([[a], [tests]]),
    [member('a#1', 1, 'passed', ['a#1', 'tests#1']), entry('c#1', 'passed', { seq: 2 })],
    "the journal holds 'c#1' after the unfinished group [a#1, tests#1]",
  ],
  [
    'the workflow ending where the journal still holds lines of a group',
    async (run) => {
      await run.all([[a], [tests]]);
      return 'early';
    },
    [
      member('tests#1', 1, 'passed', ['a#1', 'tests#1']),
      member('a#1', 2, 'passed', ['a#1', 'tests#1']),
      member('c#1', 3, 'passed', ['c#1', 'implement#1']),
    ],
    "the workflow ended where the journal has 'c#1'",
  ],
])('%s fails the run with determinism_violation, naming both sides', async (_, body, entries, message) => {
  expect(await replayed(body, entries)).toEqual(failed('determinism_violation', message));
});

test("a group's journaled error fails the run with stage_error, the first in the order given, unless that call asks for its error", async () => {
  const errored = [member('tests#1', 1, 'error', ['a#1', 'tests#1']), member('a#1', 2, 'passed', ['a#1', 'tests#1'])];
  for (const each of errored) each.reason = each.outcome === 'error' ? 'boom' : null;
  const unhandled = await replayed(async (run) => {
    await run.all([[a], [tests]]);
  }, errored);
  expect(unhandled).toEqual(failed('stage_error', 'tests#1 ended in error: boom'));

  let soft: unknown;
  const handled = await replayed(async (run) => {
    const [, t] = await run.all([[a], [tests, {}, { onError: 'return' }]]);
    soft = t;
    return 'handled';
  }, errored);
  expect({ handled, soft }).toEqual({
    handled: { kind: 'completed', result: 'handled' },
    soft: { outcome: 'error', reason: 'boom' },
  });

  const both = errored.map((each) => ({ ...each, outcome: 'error' as const, reason: `${each.key} broke` }));
  const first = await replayed(async (run) => {
    await run.all([[a], [tests]]);
  }, both);
  expect(first).toEqual(failed('stage_error', 'a#1 ended in error: a#1 broke'));
});

test.each<[string, Body, string]>([
  [
    'a stage the roster lacks',
    (run) => run.all([[a], [stray]]),
    "stray#1 can't run: 'stray' isn't a stage the workflow's roster holds",
  ],
  [
    'a bad binding',
    (run) => run.all([[a], [b, { report: { name: 'r.txt' } as ProducedFile }]]),
    "b#1 can't run: 'report' needs a file a call produced",
  ],
  [
    'an element that is not a call',
    (run) => run.all([[a], 'tests'] as never),
    "run.all()'s call 2 is not [stage, bindings, options]",
  ],
])('a group with %s fails the run with workflow_failed before any of its calls runs', async (_, body, message) => {
  expect(await replayed(body)).toEqual(failed('workflow_failed', message));
});

test('run.all([]) resolves to no results at once, and the next run.stage() is keyed as if the group were not there', async () => {
  const events: NewEvent[] = [];
  let results: unknown;
  const end = await replayed(
    async (run) => {
      results = await run.all([]);
      await run.stage(a);
    },
    [],
    (event) => events.push(event),
  );
  expect({ results, events }).toEqual({ results: [], events: [] });
  expect(end).toMatchObject({ kind: 'call', call: { key: 'a#1', stageIndex: 1 } });
});

/** The fingerprints a journaled call of `c` would carry for these value bindings. */
const valuesOf = (bound: Record<string, unknown>) =>
  fingerprintBindings(
    Object.fromEntries(
      Object.entries(bound).map(([name, each]) => [name, { kind: 'value' as const, value: each, from: '' }]),
    ),
  );
const changedMessage = (key: string, changes: string) =>
  `the workflow asked for '${key}' with other bindings than the journal's: ${changes}`;

test('a value binding changed since the journaled call fails the replay with determinism_violation, naming it', async () => {
  const entries = [entry('c#1', 'passed', { bindings: valuesOf({ data: 'one' }) })];
  const end = await replayed(async (run) => {
    await run.stage(c, { data: 'two' });
  }, entries);
  expect(end).toEqual(failed('determinism_violation', changedMessage('c#1', "'data' changed")));
});

test('a binding that is unchanged replays the journaled result, and the replay goes on to the next call', async () => {
  const entries = [entry('c#1', 'passed', { output: { ok: false }, bindings: valuesOf({ data: { b: 1, a: 2 } }) })];
  let result: unknown;
  const end = await replayed(async (run) => {
    result = await run.stage(c, { data: { a: 2, b: 1 } });
    await run.stage(tests);
  }, entries);
  expect(result).toEqual({ outcome: 'passed', output: { ok: false }, files: {} });
  expect(end).toMatchObject({ kind: 'call', call: { key: 'tests#1' } });
});

test('two sequential calls of one stage swapped between replays fail with determinism_violation at the first', async () => {
  const entries = [
    entry('c#1', 'passed', { seq: 1, bindings: valuesOf({ data: 'one' }) }),
    entry('c#2', 'passed', { seq: 2, bindings: valuesOf({ data: 'two' }) }),
  ];
  const end = await replayed(async (run) => {
    await run.stage(c, { data: 'two' });
    await run.stage(c, { data: 'one' });
  }, entries);
  expect(end).toEqual(failed('determinism_violation', changedMessage('c#1', "'data' changed")));
});

test('two calls of one stage swapped inside run.all() fail with determinism_violation, and nothing is rebuilt', async () => {
  const keys = ['c#1', 'c#2'];
  const entries = [
    entry('c#2', 'passed', { seq: 1, group: keys, bindings: valuesOf({ data: 'two' }) }),
    entry('c#1', 'passed', { seq: 2, group: keys, bindings: valuesOf({ data: 'one' }) }),
  ];
  const end = await replayed(async (run) => {
    await run.all([
      [c, { data: 'two' }],
      [c, { data: 'one' }],
    ]);
  }, entries);
  expect(end).toEqual(failed('determinism_violation', changedMessage('c#1', "'data' changed")));
});

test('a group whose journaled member kept its bindings and whose other member is still to run ends the replay with that one', async () => {
  const keys = ['c#1', 'c#2'];
  const entries = [entry('c#2', 'passed', { seq: 1, group: keys, bindings: valuesOf({ data: 'two' }) })];
  const end = await replayed(async (run) => {
    await run.all([
      [c, { data: 'one' }],
      [c, { data: 'two' }],
    ]);
  }, entries);
  expect(end).toMatchObject({ kind: 'group', keys, calls: [{ key: 'c#1' }] });
});

test('a binding that appeared, one that went and one that changed are named in that order of kind, each by name', async () => {
  const entries = [entry('c#1', 'passed', { bindings: valuesOf({ data: 'one', extra: 'x' }) })];
  const appeared = await replayed(
    async (run) => {
      await run.stage(c, { data: 'one', extra: 'x' });
    },
    [entry('c#1', 'passed', { bindings: valuesOf({ data: 'one' }) })],
  );
  expect(appeared).toEqual(failed('determinism_violation', changedMessage('c#1', "'extra' appeared")));

  const went = await replayed(async (run) => {
    await run.stage(c, { data: 'one' });
  }, entries);
  expect(went).toEqual(failed('determinism_violation', changedMessage('c#1', "'extra' went")));

  const all = await replayed(
    async (run) => {
      await run.stage(c, { data: 'two' });
    },
    [entry('c#1', 'passed', { bindings: valuesOf({ extra: 'x', data: 'one' }) })],
  );
  expect(all).toEqual(failed('determinism_violation', changedMessage('c#1', "'data' changed, 'extra' went")));
});

test('a call with no bindings in the journal that now has one is named as appeared', async () => {
  const end = await replayed(
    async (run) => {
      await run.stage(c, { data: 'one' });
    },
    [entry('c#1', 'passed', { bindings: {} })],
  );
  expect(end).toEqual(failed('determinism_violation', changedMessage('c#1', "'data' appeared")));
});

test("a file binding handed another call's file is named as changed", async () => {
  const entries = [
    entry('a#1', 'passed', { seq: 1, files: { 'r.txt': '01-a/call-1/r.txt' }, bindings: {} }),
    entry('a#2', 'passed', { seq: 2, files: { 'r.txt': '01-a/call-2/r.txt' }, bindings: {} }),
    entry('b#1', 'passed', {
      seq: 3,
      bindings: fingerprintBindings({
        report: { kind: 'file', path: join(RUN_DIR, '01-a/call-1/r.txt'), from: '01-a/call-1/r.txt' },
      }),
    }),
  ];
  const end = await replayed(async (run) => {
    await run.stage(a);
    const second = await run.stage(a);
    await run.stage(b, { report: second.files['r.txt'] });
  }, entries);
  expect(end).toEqual(failed('determinism_violation', changedMessage('b#1', "'report' changed")));
});

test('a journaled call whose bindings the workflow can no longer resolve fails with determinism_violation', async () => {
  const entries = [entry('b#1', 'passed', { bindings: { report: '0123456789abcdef' } })];
  const end = await replayed(async (run) => {
    await run.stage(b, { report: { name: 'r.txt' } as ProducedFile });
  }, entries);
  expect(end).toEqual(
    failed(
      'determinism_violation',
      "the workflow asked for 'b#1' with bindings the journal can't match: 'report' needs a file a call produced",
    ),
  );
});

test('a journaled error whose bindings changed reports determinism_violation, not stage_error', async () => {
  const entries = [entry('c#1', 'error', { reason: 'boom', bindings: valuesOf({ data: 'one' }) })];
  const end = await replayed(async (run) => {
    await run.stage(c, { data: 'two' });
  }, entries);
  expect(end).toEqual(failed('determinism_violation', changedMessage('c#1', "'data' changed")));
});

test('a journal line without bindings keeps the key-only check, whatever the workflow binds now', async () => {
  const entries = [entry('c#1', 'passed'), entry('c#2', 'passed', { seq: 2 })];
  let outcomes: string[] = [];
  const end = await replayed(async (run) => {
    const first = await run.stage(c, { data: 'anything', extra: 'new' });
    const second = await run.stage(c, {} as never);
    outcomes = [first.outcome, second.outcome];
    await run.stage(tests);
  }, entries);
  expect(outcomes).toEqual(['passed', 'passed']);
  expect(end).toMatchObject({ kind: 'call', call: { key: 'tests#1' } });
});
