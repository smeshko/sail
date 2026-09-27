import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { JournalEntry } from '../../src/engine/journal';
import type { ReachedStage } from '../../src/engine/load-workflow';
import { type ReplayEnd, replay } from '../../src/engine/replay';
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
/** A stage the workflow reaches at run time but its roster doesn't hold. */
const stray = script('stray', { run: './run.sh', output: Report });

const reached = (definition: StageDefinition): ReachedStage => ({
  definition,
  dir: `/repo/.sail/stages/${definition.name}`,
  module: {},
});
const STAGES = [a, b, c, planner].map(reached);

type Body = (run: Run<typeof ticket.output>) => Promise<unknown>;

/** Replays a workflow whose body is `body` against `entries`. */
function replayed(body: Body, entries: JournalEntry[] = []): Promise<ReplayEnd> {
  const flow = workflow('flow', { intake: ticket }, body);
  return replay({ workflow: flow as never, stages: STAGES, entries, runDir: RUN_DIR, input: INPUT });
}

/** A journaled call of `key`, `stage#call`, in stage directory `index`. */
function entry(key: string, outcome: JournalEntry['outcome'], fields: Partial<JournalEntry> = {}): JournalEntry {
  const [stage = '', call = '1'] = key.split('#');
  const index = { a: 1, b: 2, c: 2, planner: 3 }[stage] ?? 9;
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
