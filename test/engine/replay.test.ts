import { expect, test } from 'bun:test';
import { join } from 'node:path';
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

const RUN_DIR = '/runs/LOCAL-01M3J94G5X7C627GTFB2M111ZT';
const INPUT = { ticketKey: 'FAKE-1', title: 'a ticket' };

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

/** Replays a workflow whose body is `body` against `entries`, its events going to `emit` when one is given. */
function replayed(body: Body, entries: JournalEntry[] = [], emit?: Emit): Promise<ReplayEnd> {
  const flow = workflow('flow', { intake: ticket }, body);
  const options = { workflow: flow as never, stages: STAGES, entries, runDir: RUN_DIR, input: INPUT };
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

test("a value binding records where it came from: a call's output, --input, or the workflow", async () => {
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

  const fromInput = await replayed(async (run) => {
    await run.stage(c, { data: run.input });
  });
  expect(fromInput).toMatchObject({ call: { supplied: { data: { kind: 'value', value: INPUT, from: '--input' } } } });

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
    run.input.acceptanceCriteria.push('two');
  });
  const changesInput = await replay({ workflow: flow as never, stages: STAGES, entries: [], runDir: RUN_DIR, input });
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
    runId: 'LOCAL-01M3J94G5X7C627GTFB2M111ZT',
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

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ("a first pass past the journal's end reports its iteration, then the route into it", async () => {
    const { events, emit } = collect();
    const end = await replayed(fixLoop(), journalTo('a#1'), emit);
    expect(end).toMatchObject({ kind: 'call', call: { key: 'implement#1' } });
    expect(events).toEqual([
      { type: 'loop:iteration', loop: 'fix', iteration: 1, max: 3 },
      { type: 'workflow:route', at: 'a#1', value: 'passed', took: 'implement#1' },
    ]);
    checkStamped(events);
  });

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a pass after a failed one names the output its feedback came from, and the route records the failure', async () => {
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

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('feedback the workflow builds itself comes from the workflow', async () => {
    const { events, emit } = collect();
    await replayed(fixLoop(() => ({ ok: false })), journalTo('tests#1'), emit);
    expect(events[0]).toEqual({ type: 'loop:iteration', loop: 'fix', iteration: 2, max: 3, feedback: { from: 'workflow' } });
  });

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('moves the journal already holds are not reported again', async () => {
    const { events, emit } = collect();
    await replayed(fixLoop(), journalTo('implement#2'), emit);
    expect(events).toEqual([{ type: 'workflow:route', at: 'implement#2', value: 'passed', took: 'tests#2' }]);
  });

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ("break reports the loop's exit at the workflow's next move, before its route", async () => {
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

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a throw out of a loop body is not an exit', async () => {
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

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('asking for the pass after max reports the loop exceeded, and no route', async () => {
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

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a route is reported for the moves the workflow made: its end, run.fail(), never an end the engine made', async () => {
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
    const loopThen = (next: (run: Run<typeof ticket.output>) => Promise<unknown>): Body => async (run) => {
      await run.stage(a);
      for (const _ of run.loop('fix', { max: 3 })) await next(run);
    };
    const iteration = { type: 'loop:iteration', loop: 'fix', iteration: 1, max: 3 } as const;
    expect(await reported(loopThen((run) => run.stage(b, { report: { name: 'r.txt' } as ProducedFile })), after)).toEqual([
      iteration,
    ]);
    expect(await reported(loopThen((run) => run.stage(stray)), after)).toEqual([iteration]);
    expect(await reported(returns, [entry('a#1', 'error', { reason: 'boom' })])).toEqual([]);
    expect(await reported(returns, [entry('a#1', 'passed'), entry('c#1', 'passed')])).toEqual([]);
  });
