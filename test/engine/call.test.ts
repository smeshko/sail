// The script step's contract end to end: runCall() in a temporary repository, each result.json read back from disk.
import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createFakeHarness, type ScriptedAnswer } from '../../src/adapters/fake/harness';
import type { Supplied } from '../../src/engine/bindings';
import { type CallRequest, callProblems, runCall } from '../../src/engine/call';
import { callPaths, nextTry } from '../../src/engine/call-dir';
import type { ContractError } from '../../src/engine/contract';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import { createBus } from '../../src/events/bus';
import { createEventsFile, EVENTS_FILE, ndjsonConsumer, nextSeq, readEvents } from '../../src/events/consumers/ndjson';
import { summarize } from '../../src/events/summary';
import type { Emit, NewEvent, SailEvent } from '../../src/events/types';
import type { Harness } from '../../src/ports/harness';
import { agent, file, type StageDefinition, script, stage, value, z } from '../../src/sdk/index';
import { runStart } from '../helpers/events';
import { recording } from '../helpers/scripted-harness';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const RUN_ID = 'tests-01ARYZ6S410000000000000000';
const golden = join(import.meta.dir, '..', 'fixtures', 'runs', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');

const TestReport = z.object({
  ok: z.boolean(),
  total: z.number().int(),
  failed: z.number().int(),
  durationMs: z.number().int(),
  failures: z.array(z.object({ test: z.string(), file: z.string(), message: z.string() })),
});

const REPORT = '{"ok":%s,"total":1,"failed":%s,"durationMs":5,"failures":[]}';

/** Exits with the code bound as `exit`, after writing junit.xml and a report that agrees with it. */
const BY_BINDING = `echo "<testsuites/>" > "$STAGE_OUT/junit.xml"
code=$(cat "$INPUT_EXIT")
if [ "$code" = 0 ]; then printf '${REPORT}\\n' true 0; else printf '${REPORT}\\n' false 1; fi
exit "$code"`;

interface Stage {
  request: (definition: StageDefinition, supplied?: Record<string, Supplied>) => CallRequest;
  run: (body: string) => void;
}

/** `.sail/stages/tests/` in the repository, with a run directory under `.sail-runs/`. */
function tests(repo: TempRepo): Stage {
  const stageDir = join(repo.dir, '.sail', 'stages', 'tests');
  mkdirSync(stageDir, { recursive: true });
  return {
    request: (definition, supplied = {}) => ({
      runDir: join(repo.dir, '.sail-runs', RUN_ID),
      runId: RUN_ID,
      stageIndex: 0,
      call: 1,
      definition,
      stageFile: join(stageDir, 'stage.ts'),
      workspace: repo.dir,
      config: join(repo.dir, '.sail', 'project.yaml'),
      supplied,
      graceMs: 500,
    }),
    run: (body) => {
      writeFileSync(join(stageDir, 'run.sh'), `#!/bin/bash\n${body}\n`);
      chmodSync(join(stageDir, 'run.sh'), 0o755);
    },
  };
}

const testsStep = (options: { timeoutSeconds?: number } = {}) =>
  script('tests', {
    run: './run.sh',
    consumes: { exit: value(z.number()) },
    produces: { 'junit.xml': 'file' },
    output: TestReport,
    ...options,
  });

const exitWith = (code: number): Record<string, Supplied> => ({ exit: { kind: 'value', value: code, from: '--bind' } });

/** Reads result.json back from disk and checks it against sail.result.v1. */
function readBack(path: string): Record<string, unknown> {
  const result = JSON.parse(readFileSync(path, 'utf8'));
  expect(validateDocument('sail.result.v1', result).map(formatIssue)).toEqual([]);
  console.log(`${result.key} ${result.outcome}${result.errors ? `  ${JSON.stringify(result.errors)}` : ''}`);
  return result;
}

test('a tests stage ends passed on exit 0 and failed on exit 1, with its typed report', async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    s.run(BY_BINDING);
    for (const [code, outcome, ok] of [
      [0, 'passed', true],
      [1, 'failed', false],
    ] as const) {
      const request = { ...s.request(testsStep(), exitWith(code)), call: code + 1 };
      const { paths } = await runCall(request);
      const result = readBack(paths.result);
      expect(result).toMatchObject({
        key: `tests#${code + 1}`,
        outcome,
        output: { ok, total: 1, failed: ok ? 0 : 1, durationMs: 5, failures: [] },
        consumed: { exit: '--bind' },
        exit: { code, mapped: outcome },
      });
      expect(Object.keys(result.files as object)).toEqual(['junit.xml']);
      expect(readdirSync(paths.dir).sort()).toEqual(['in', 'junit.xml', 'result.json', 'stderr.log', 'stdout.log']);
      expect(readdirSync(paths.stageIn)).toEqual(['exit.json']);
    }
  });
});

test('invalid JSON on stdout is error with the parse error, and a wrong shape is error with the Zod message', async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    s.run(`echo "<testsuites/>" > "$STAGE_OUT/junit.xml"\necho 'not json'`);
    const notJson = readBack((await runCall(s.request(testsStep(), exitWith(0)))).paths.result);
    expect(notJson).toMatchObject({ outcome: 'error', output: null });
    expect(notJson.errors).toEqual([
      { reason: 'invalid_output', message: expect.stringMatching(/^the last stdout line is not JSON: /) },
    ]);

    s.run(`echo "<testsuites/>" > "$STAGE_OUT/junit.xml"\necho '{"ok":true}'`);
    const shape = readBack((await runCall({ ...s.request(testsStep(), exitWith(0)), call: 2 })).paths.result);
    expect(shape.errors).toEqual([
      {
        reason: 'invalid_output',
        message: expect.stringContaining('expected number, received undefined\n  → at total'),
      },
    ]);
  });
});

test('a missing declared file is error, naming the file', async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    s.run(`printf '${REPORT}\\n' true 0`);
    const result = readBack((await runCall(s.request(testsStep(), exitWith(0)))).paths.result);
    expect(result).toMatchObject({
      outcome: 'error',
      files: {},
      errors: [{ reason: 'missing_file', message: "'junit.xml' was not produced in $STAGE_OUT" }],
    });
  });
});

test('a timeout ends in error within the grace period, and no child survives', async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    const pidFile = join(repo.dir, 'grandchild.pid');
    s.run(`sleep 30 &\necho $! > "${pidFile}"\nsleep 5`);
    const started = performance.now();
    const { paths } = await runCall(s.request(testsStep({ timeoutSeconds: 1 }), exitWith(0)));
    const ms = performance.now() - started;
    console.log(`timeout: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(3500);
    expect(readBack(paths.result)).toMatchObject({
      outcome: 'error',
      output: null,
      errors: [{ reason: 'timeout', message: 'timed out after 1s' }],
      exit: { code: null, signal: 'SIGTERM' },
    });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });
});

test("a stage with no bindings records the golden result's env keys, in the same order", async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    s.run(`echo "<testsuites/>" > "$STAGE_OUT/junit.xml"\nprintf '${REPORT}\\n' true 0`);
    const plain = script('tests', { run: './run.sh', produces: { 'junit.xml': 'file' }, output: TestReport });
    const result = readBack((await runCall(s.request(plain))).paths.result);
    const goldenEnv = JSON.parse(readFileSync(join(golden, '03-tests', 'call-2', 'result.json'), 'utf8')).env;
    expect(Object.keys(result.env as object)).toEqual(Object.keys(goldenEnv));
    expect(result.env).toMatchObject({ STAGE_IN: `.sail-runs/${RUN_ID}/00-tests/call-1/in`, WORKSPACE: '.' });
    expect(result.consumed).toEqual({});
  });
});

test('a later try writes into call-N/try-M/, and its script sees TRY as M', async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    s.run(`echo "<testsuites/>" > "$STAGE_OUT/junit.xml"\nprintf '${REPORT}\\n' true 0`);
    const plain = script('tests', { run: './run.sh', produces: { 'junit.xml': 'file' }, output: TestReport });
    const { paths } = await runCall({ ...s.request(plain), try: 2 });
    expect(paths.result).toBe(join(repo.dir, '.sail-runs', RUN_ID, '00-tests', 'call-1', 'try-2', 'result.json'));
    expect(readBack(paths.result)).toMatchObject({
      key: 'tests#1',
      outcome: 'passed',
      files: { 'junit.xml': { path: '00-tests/call-1/try-2/junit.xml' } },
      env: {
        TRY: '2',
        STAGE_IN: `.sail-runs/${RUN_ID}/00-tests/call-1/try-2/in`,
        STAGE_OUT: `.sail-runs/${RUN_ID}/00-tests/call-1/try-2`,
      },
    });
  });
});

const budget = { maxTurns: 1, maxUsd: 1, maxMinutes: 1 };
const permissions = { read: [], write: [], commands: [] };
const spec = agent('spec', { prompt: './prompt.md', output: z.object({}), permissions, budget });
const Out = z.object({ ok: z.boolean() });
const twoSteps = stage('two', {
  output: Out,
  steps: [script('a', { run: './a.sh', output: z.object({}) }), script('b', { run: './b.sh', output: Out })],
});

test('a multi-step stage is refused, and gets no call directory', async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    expect(callProblems(twoSteps, {})).toEqual(["multi-step stages can't run yet"]);
    await expect(runCall(s.request(twoSteps))).rejects.toThrow("multi-step stages can't run yet");
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

const UNRESOLVED = "agent steps need a harness and a model, which weren't resolved";

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('an agent call with no harness and model resolved is refused, and gets no call directory; with them, its problems are its step and its bindings', async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    expect(callProblems(spec, {})).toEqual([UNRESOLVED]);
    await expect(runCall(s.request(spec))).rejects.toThrow(UNRESOLVED);
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);

    const on = { harness: createFakeHarness({ script: {} }), model: 'claude-opus-5-5' };
    expect(callProblems(spec, {}, on)).toEqual([]);
    const reading = agent('spec', {
      prompt: './prompt.md',
      consumes: { brief: file('brief.md') },
      produces: { 'result.json': 'file' },
      output: z.object({}),
      permissions,
      budget,
    });
    expect(callProblems(reading, {}, on)).toEqual([
      "'result.json' can't be produced: the engine writes it in $STAGE_OUT",
      "'brief' is required",
    ]);
  });
});

test("callProblems lists the step's own problems, then its bindings'", () => {
  const step = script('tests', {
    run: './run.sh',
    consumes: { exit: value(z.number()) },
    output: TestReport,
    timeoutSeconds: 0,
  });
  expect(callProblems(step, { nope: { kind: 'value', value: 1, from: '--bind' } })).toEqual([
    'timeoutSeconds must be a positive number: 0',
    "'nope' is not a binding of this stage",
    "'exit' is required",
  ]);
});

const TS = '2026-09-28T09:00:00.000Z';
const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

/** An emitter that keeps every event it is given. */
function collect(): { events: NewEvent[]; emit: Emit } {
  const events: NewEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

/** Checks each event against sail.event.v1, stamped as the bus would stamp it. */
function checkStamped(events: readonly NewEvent[]): void {
  const stamped = events.map((event, i) => ({ seq: i + 1, ts: TS, runId: RUN_ID, ...event }));
  expect(stamped.flatMap((event) => validateDocument('sail.event.v1', event)).map(formatIssue)).toEqual([]);
}

const types = (events: readonly NewEvent[]): string[] => events.map((event) => event.type);
const keys = (events: readonly NewEvent[]): unknown[] =>
  events.map((event) => ('key' in event ? event.key : undefined));

/** A tests step with no bindings. */
const plainStep = (options: { timeoutSeconds?: number } = {}) =>
  script('tests', { run: './run.sh', produces: { 'junit.xml': 'file' }, output: TestReport, ...options });

const PASSES = `echo "<testsuites/>" > "$STAGE_OUT/junit.xml"\nprintf '${REPORT}\\n' true 0`;
const ENV_KEYS = ['RUN_ID', 'STAGE', 'CALL', 'TRY', 'STAGE_IN', 'STAGE_OUT', 'WORKSPACE', 'SAIL_CONFIG'];

test('a passing call reports its events in order, each keyed by its call', async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    s.run(PASSES);
    const { events, emit } = collect();
    const { result, paths } = await runCall({ ...s.request(plainStep()), emit });
    console.log(types(events).join(' '));

    expect(types(events)).toEqual([
      'stage:start',
      'script:exec',
      'script:exit',
      'output:validated',
      'file:produced',
      'stage:end',
    ]);
    expect(keys(events)).toEqual(Array(6).fill('tests#1'));
    checkStamped(events);
    expect(events).toMatchObject([
      { stage: 'tests', call: 1, try: 1, kind: 'script', consumed: {} },
      { command: '.sail/stages/tests/run.sh', cwd: '.', envKeys: ENV_KEYS },
      { code: 0, outcome: 'passed', durationMs: expect.any(Number), stdoutBytes: statSync(paths.stdout).size },
      {},
      { name: 'junit.xml', path: '00-tests/call-1/junit.xml', bytes: 14, sha256: sha256('<testsuites/>\n') },
      {
        stage: 'tests',
        call: 1,
        try: 1,
        outcome: 'passed',
        durationMs: result.durationMs,
        resultPath: '00-tests/call-1/result.json',
      },
    ]);
    expect(events[2]).not.toHaveProperty('signal');
    expect(events[5]).not.toHaveProperty('errors');
  });
});

test('each bound binding reports where it came from, in the order the stage declares them, and an unbound one nothing', async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    s.run(PASSES);
    const spec = join(repo.dir, 'spec.md');
    writeFileSync(spec, '# spec\n');
    const step = script('tests', {
      run: './run.sh',
      consumes: { spec: file('spec.md'), exit: value(z.number()), note: value(z.string()).optional() },
      produces: { 'junit.xml': 'file' },
      output: TestReport,
    });
    const supplied: Record<string, Supplied> = {
      exit: { kind: 'value', value: 0, from: '--bind' },
      spec: { kind: 'file', path: spec, from: '01-spec/call-1/spec.md' },
    };
    const { events, emit } = collect();
    await runCall({ ...s.request(step, supplied), emit });

    expect(types(events).slice(0, 4)).toEqual([
      'stage:start',
      'input:materialised',
      'input:materialised',
      'script:exec',
    ]);
    expect(events.slice(1, 3)).toEqual([
      { type: 'input:materialised', key: 'tests#1', binding: 'spec', from: '01-spec/call-1/spec.md' },
      { type: 'input:materialised', key: 'tests#1', binding: 'exit', from: '--bind' },
    ]);
    const [start] = events;
    if (start?.type !== 'stage:start') throw new Error('stage:start first');
    expect(start.consumed).toEqual({ spec: '01-spec/call-1/spec.md', exit: '--bind' });
    expect(start.consumed).not.toHaveProperty('note');
    checkStamped(events);
  });
});

test("an output that breaks its schema reports output:invalid with the contract's message, and stage:end its errors", async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    s.run(`echo "<testsuites/>" > "$STAGE_OUT/junit.xml"\necho '{"ok":true}'`);
    const { events, emit } = collect();
    const { result } = await runCall({ ...s.request(plainStep()), emit });
    const message = (result.errors as { message: string }[])[0]?.message ?? '';
    expect(message).toStartWith("the output doesn't match its schema:\n");

    expect(types(events)).toEqual([
      'stage:start',
      'script:exec',
      'script:exit',
      'output:invalid',
      'file:produced',
      'stage:end',
    ]);
    expect(events[3]).toEqual({ type: 'output:invalid', key: 'tests#1', message });
    expect(events[5]).toMatchObject({ outcome: 'error', errors: [{ reason: 'invalid_output', message }] });
    checkStamped(events);
  });
});

test('a timeout reports the signal and error:timeout, and nothing about output or files', async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    s.run('sleep 5');
    const { events, emit } = collect();
    await runCall({ ...s.request(plainStep({ timeoutSeconds: 1 })), emit });

    expect(types(events)).toEqual(['stage:start', 'script:exec', 'script:exit', 'error:timeout', 'stage:end']);
    expect(events[2]).toMatchObject({ type: 'script:exit', code: null, signal: 'SIGTERM' });
    expect(events[2]).not.toHaveProperty('outcome');
    expect(events[3]).toEqual({
      type: 'error:timeout',
      key: 'tests#1',
      message: 'timed out after 1s',
      timeoutSeconds: 1,
    });
    expect(events[4]).toMatchObject({
      outcome: 'error',
      errors: [{ reason: 'timeout', message: 'timed out after 1s' }],
    });
    checkStamped(events);
  });
});

test("a later try reports its try, under its call's key", async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    s.run(PASSES);
    const { events, emit } = collect();
    await runCall({ ...s.request(plainStep()), try: 2, emit });

    expect(keys(events)).toEqual(Array(6).fill('tests#1'));
    expect(events[0]).toMatchObject({ type: 'stage:start', try: 2 });
    expect(events.at(-1)).toMatchObject({ type: 'stage:end', try: 2, resultPath: '00-tests/call-1/try-2/result.json' });
  });
});

test('a call that crashes creating its directory has still reported its start', async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    s.run(PASSES);
    const request = s.request(plainStep());
    mkdirSync(join(request.runDir, '00-tests', 'call-1'), { recursive: true });
    const { events, emit } = collect();

    await expect(runCall({ ...request, emit })).rejects.toThrow('EEXIST');
    expect(types(events)).toEqual(['stage:start']);
    expect(keys(events)).toEqual(['tests#1']);
  });
});

// Agent calls: runCall() on the fake harness, which answers by try, so a script says what each try's session submits.

const MODEL = 'claude-opus-5-5';
const KEY = 'spec#1';
const SpecOutput = z.object({ summary: z.string() });
const SPEC = { summary: 'Add a --shout flag.' };
const NOT_A_STRING = '✖ Invalid input: expected string, received number\n  → at summary';
const NOT_PRODUCED = "'spec.md' was not produced in $STAGE_OUT";

interface SpecOptions {
  onInvalidOutput?: 'retry-once' | 'fail';
  prompt?: string;
  maxTurns?: number;
}

/** The `spec` step: it reads a brief, writes `spec.md` and submits a summary. */
const specStep = ({ maxTurns = 5, ...options }: SpecOptions = {}) =>
  agent('spec', {
    prompt: './prompt.md',
    consumes: { brief: file('brief.md') },
    produces: { 'spec.md': 'file' },
    output: SpecOutput,
    permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
    budget: { maxTurns, maxUsd: 1, maxMinutes: 5 },
    ...options,
  });

type Submitted = Extract<ScriptedAnswer, { outcome: 'done' }>;

/** A session that submits `output` for `costUsd`, and writes `spec.md` unless `extra` says otherwise. */
const submits = (output: unknown, costUsd: number, extra: Partial<Submitted> = {}): ScriptedAnswer => ({
  outcome: 'done',
  output,
  files: { 'spec.md': '# Spec\n' },
  usage: { costUsd },
  ...extra,
});

/** The fake harness answering `spec`'s tries with `answers` in order, keeping each request. */
const fake = (answers: ScriptedAnswer[], hooks?: Parameters<typeof recording>[1]) =>
  recording(createFakeHarness({ script: { spec: answers } }), hooks);

interface SpecStage {
  runDir: string;
  /** `01-spec/call-<call>/`, or its `try-<n>/` from the second try on. */
  dir(tryNumber?: number, call?: number): string;
  /** The request of `spec#1` on `harness`, starting at the call's next try as the runtime does. */
  request(definition: StageDefinition, harness: Harness, extra?: Partial<CallRequest>): CallRequest;
}

/** `.sail/stages/spec/` in the repository, with its prompt and a brief to bind, and a run directory. */
function specStage(repo: TempRepo): SpecStage {
  const stageDir = join(repo.dir, '.sail', 'stages', 'spec');
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, 'prompt.md'), 'Write the spec from {{brief}}.\n');
  writeFileSync(join(stageDir, 'unknown.md'), 'Write the spec for {{ticket.key}}.\n');
  mkdirSync(join(repo.dir, 'docs'));
  writeFileSync(join(repo.dir, 'docs', 'brief.md'), '# Brief\n');
  const runDir = join(repo.dir, '.sail-runs', RUN_ID);
  return {
    runDir,
    dir: (tryNumber = 1, call = 1) => callPaths(runDir, 1, 'spec', call, tryNumber).dir,
    request: (definition, harness, extra = {}) => ({
      runDir,
      runId: RUN_ID,
      stageIndex: 1,
      call: 1,
      try: nextTry(runDir, 1, 'spec', extra.call ?? 1),
      definition,
      stageFile: join(stageDir, 'stage.ts'),
      workspace: repo.dir,
      config: join(repo.dir, '.sail', 'project.yaml'),
      supplied: { brief: { kind: 'file', path: join(repo.dir, 'docs', 'brief.md'), from: 'docs/brief.md' } },
      agent: { harness, model: MODEL, conventions: [] },
      ...extra,
    }),
  };
}

/** The text at `path`, or null when nothing is there. */
const textAt = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);

const errorsOf = (result: Record<string, unknown>): ContractError[] => (result.errors ?? []) as ContractError[];

/** A result's outcome and its place among its call's tries. */
const placeOf = (result: Record<string, unknown>) => ({
  outcome: result.outcome,
  try: result.try,
  validationTry: result.validationTry,
  validationFailed: result.validationFailed,
});

/** A result as its `result.json` holds it. */
const written = (result: Record<string, unknown>): unknown => JSON.parse(JSON.stringify(result));

/** Each `stage:start` and `stage:end`, as `start <try>` and `end <try> <outcome>`. */
const stageEvents = (events: readonly NewEvent[]): string[] =>
  events.flatMap((event) => {
    if (event.type === 'stage:start') return [`start ${event.try}`];
    return event.type === 'stage:end' ? [`end ${event.try} ${event.outcome}`] : [];
  });

/** The run's events file as its bus: an event emitted is appended, numbered on from what the file holds. */
function stream(runDir: string): Emit {
  mkdirSync(runDir, { recursive: true });
  if (!existsSync(join(runDir, EVENTS_FILE))) createEventsFile(runDir);
  const firstSeq = nextSeq(runDir);
  if (typeof firstSeq !== 'number') throw new Error(firstSeq.refused);
  return createBus({ runId: RUN_ID, firstSeq, consumers: [ndjsonConsumer(runDir)] }).emit;
}

/** Cuts the events file after its last event `last` accepts: what a crash leaves of a file that is never synced. */
function cutEventsAfter(runDir: string, last: (event: SailEvent) => boolean): void {
  const path = join(runDir, EVENTS_FILE);
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  const index = lines.findLastIndex((line) => last(JSON.parse(line) as SailEvent));
  if (index < 0) throw new Error('the events file holds no event to cut after');
  writeFileSync(
    path,
    lines
      .slice(0, index + 1)
      .map((line) => `${line}\n`)
      .join(''),
  );
}

/** Every session end among `events`. */
const sessionEnds = (events: readonly SailEvent[]) =>
  events.flatMap((event) => (event.type === 'harness:session_end' ? [event] : []));

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('invalid output is corrected once: a second try in try-2/, with bindings of its own and the messages of the first in its prompt, ends the call done', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    const draft = submits({ summary: 3 }, 0.125, { files: { 'spec.md': '# Draft\n' } });
    const harness = fake([draft, submits(SPEC, 0.25)]);
    const { events, emit } = collect();
    const { result, paths } = await runCall(s.request(specStep(), harness, { emit }));

    const sent = harness.requests.map(({ try: n, env }) => [n, env.TRY, env.STAGE_OUT, env.STAGE_IN, env.INPUT_BRIEF]);
    expect(sent).toEqual([
      [1, '1', s.dir(1), join(s.dir(1), 'in'), join(s.dir(1), 'in', 'brief.md')],
      [2, '2', s.dir(2), join(s.dir(2), 'in'), join(s.dir(2), 'in', 'brief.md')],
    ]);
    expect(paths).toEqual(callPaths(s.runDir, 1, 'spec', 1, 2));
    const first = readBack(join(s.dir(1), 'result.json'));
    const second = readBack(paths.result);
    const feedback = errorsOf(first)[0]?.message ?? '';
    expect(errorsOf(first)).toEqual([{ reason: 'invalid_output', message: expect.stringContaining(NOT_A_STRING) }]);
    expect([placeOf(first), placeOf(second)]).toEqual([
      { outcome: 'error', try: 1, validationTry: 1, validationFailed: true },
      { outcome: 'done', try: 2, validationTry: 2, validationFailed: false },
    ]);
    expect({ output: second.output, errors: second.errors, usage: [first.usage, second.usage] }).toEqual({
      output: SPEC,
      errors: undefined,
      usage: [{ costUsd: 0.125 }, { costUsd: 0.25 }],
    });
    expect(written(result)).toEqual(second);
    expect(second.files).toMatchObject({ 'spec.md': { path: '01-spec/call-1/try-2/spec.md' } });

    // Each try keeps the prompt its session was sent, and only the second holds the first's messages.
    const [one = '', two = ''] = harness.requests.map((request) => request.prompt);
    expect([textAt(join(s.dir(1), 'prompt.md')), textAt(join(s.dir(2), 'prompt.md'))]).toEqual([one, two]);
    expect(one).toStartWith(`Write the spec from ${join(s.dir(1), 'in', 'brief.md')}.\n`);
    expect(two).toStartWith(`Write the spec from ${join(s.dir(2), 'in', 'brief.md')}.\n`);
    expect([one.includes(feedback), two.includes(feedback)]).toEqual([false, true]);
    // What the first try left stays as it left it.
    expect([textAt(join(s.dir(1), 'spec.md')), textAt(join(s.dir(2), 'spec.md'))]).toEqual(['# Draft\n', '# Spec\n']);
    expect(stageEvents(events)).toEqual(['start 1', 'end 1 error', 'start 2', 'end 2 done']);
    const session = ['prompt:rendered', 'harness:session_start', 'usage:update', 'harness:session_end'];
    expect(types(events)).toEqual([
      ...['stage:start', 'input:materialised', ...session, 'output:invalid', 'file:produced', 'stage:end'],
      ...['stage:start', 'input:materialised', ...session, 'output:validated', 'file:produced', 'stage:end'],
    ]);
    // A try starts as the golden run's agent calls do: with the model, permissions and budget it runs on.
    const { permissions: allowed, budget: limits } = specStep();
    expect(events[0]).toEqual({
      type: 'stage:start',
      key: KEY,
      stage: 'spec',
      call: 1,
      try: 1,
      kind: 'agent',
      model: MODEL,
      consumed: { brief: 'docs/brief.md' },
      permissions: allowed,
      budget: limits,
    });
    expect(keys(events)).toEqual(Array(events.length).fill(KEY));
    checkStamped(events);
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('invalid output twice ends the call in error on its second try, listing the problems of both tries in order, each once', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    const harness = recording(
      createFakeHarness({
        script: {
          spec: [submits({ summary: 3 }, 0.125), submits({ summary: null }, 0.25), submits(SPEC, 0.5)],
          'spec#2': [submits({ summary: 3 }, 0.125)],
        },
      }),
    );
    const { events, emit } = collect();
    const { result, paths } = await runCall(s.request(specStep(), harness, { emit }));

    expect(harness.requests.map((request) => request.try)).toEqual([1, 2]);
    expect(paths.dir).toBe(s.dir(2));
    const [first] = errorsOf(readBack(join(s.dir(1), 'result.json')));
    const final = readBack(paths.result);
    expect(placeOf(final)).toEqual({ outcome: 'error', try: 2, validationTry: 2, validationFailed: true });
    expect(errorsOf(final).map((error) => error.reason)).toEqual(['invalid_output', 'invalid_output']);
    expect(errorsOf(final)[0]).toEqual(first as ContractError);
    expect(first?.message).toContain('expected string, received number');
    expect(errorsOf(final)[1]?.message).toContain('expected string, received null');
    expect(written(result)).toEqual(final);
    expect(events.at(-1)).toMatchObject({ type: 'stage:end', try: 2, outcome: 'error', errors: errorsOf(final) });
    expect(existsSync(s.dir(3))).toBe(false);

    // The same problem from both tries is listed once.
    const again = await runCall(s.request(specStep(), harness, { call: 2 }));
    expect(harness.requests).toHaveLength(4);
    const repeated = errorsOf(readBack(join(s.dir(1, 2), 'result.json')));
    expect(repeated).toHaveLength(1);
    expect(errorsOf(readBack(again.paths.result))).toEqual(repeated);
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('onInvalidOutput fail ends the call in error after one session, with one result', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    const harness = fake([submits({ summary: 3 }, 0.125), submits(SPEC, 0.25)]);
    const { paths } = await runCall(s.request(specStep({ onInvalidOutput: 'fail' }), harness));

    expect(harness.requests).toHaveLength(1);
    expect(paths.dir).toBe(s.dir(1));
    const result = readBack(paths.result);
    expect(placeOf(result)).toEqual({ outcome: 'error', try: 1, validationTry: 1, validationFailed: true });
    expect(errorsOf(result)).toEqual([{ reason: 'invalid_output', message: expect.stringContaining(NOT_A_STRING) }]);
    expect(existsSync(s.dir(2))).toBe(false);
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a declared file left out is corrected as invalid output is, and the second try is told which file', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    const harness = fake([submits(SPEC, 0.125, { files: {} }), submits(SPEC, 0.25)]);
    const { paths } = await runCall(s.request(specStep(), harness));

    expect(harness.requests.map((request) => request.try)).toEqual([1, 2]);
    const first = readBack(join(s.dir(1), 'result.json'));
    expect(errorsOf(first)).toEqual([{ reason: 'missing_file', message: NOT_PRODUCED }]);
    expect(placeOf(first)).toEqual({ outcome: 'error', try: 1, validationTry: 1, validationFailed: true });
    expect(harness.requests[1]?.prompt).toContain(NOT_PRODUCED);
    expect(placeOf(readBack(paths.result))).toEqual({
      outcome: 'done',
      try: 2,
      validationTry: 2,
      validationFailed: false,
    });
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a session that fails, one out of turns and a prompt that cannot be rendered are not corrected: one result each, and no second try', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    const harness = recording(
      createFakeHarness({
        script: {
          'spec#1': [{ outcome: 'error', message: 'model overloaded' }, submits(SPEC, 0.25)],
          'spec#2': [submits(SPEC, 0.5, { turns: 8 }), submits(SPEC, 0.25)],
          'spec#3': [submits(SPEC, 0.25)],
        },
      }),
    );
    const steps = [specStep(), specStep({ maxTurns: 4 }), specStep({ prompt: './unknown.md' })];
    const dirs: string[] = [];
    for (const [index, step] of steps.entries()) {
      dirs.push((await runCall(s.request(step, harness, { call: index + 1 }))).paths.dir);
    }

    // The third call never reached a session.
    expect(harness.requests.map(({ key, try: n }) => [key, n])).toEqual([
      ['spec#1', 1],
      ['spec#2', 1],
    ]);
    expect(dirs).toEqual([s.dir(1, 1), s.dir(1, 2), s.dir(1, 3)]);
    const results = dirs.map((dir) => readBack(join(dir, 'result.json')));
    expect(results.map(errorsOf)).toEqual([
      [{ reason: 'harness', message: 'model overloaded' }],
      [{ reason: 'budget_exceeded', message: 'budget exceeded: maxTurns 4' }],
      [
        {
          reason: 'not_started',
          message: expect.stringContaining('.sail/stages/spec/unknown.md: line 1: unknown path `ticket.key`'),
        },
      ],
    ]);
    expect(results.map(placeOf)).toEqual(
      Array(3).fill({ outcome: 'error', try: 1, validationTry: 1, validationFailed: false }),
    );
    expect(results.map((result) => result.usage)).toEqual([{ costUsd: 0 }, { costUsd: 0.25 }, { costUsd: 0 }]);
    expect([1, 2, 3].map((call) => existsSync(s.dir(2, call)))).toEqual([false, false, false]);
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('no corrective try starts once the call is aborted: after a try that ended invalid, and during a session', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    const stopped = new AbortController();
    const harness = fake([submits({ summary: 3 }, 0.125), submits(SPEC, 0.25)], { after: () => stopped.abort() });
    const invalid = await runCall(s.request(specStep(), harness, { signal: stopped.signal }));

    expect(harness.requests).toHaveLength(1);
    expect(invalid.paths.dir).toBe(s.dir(1));
    // Its output was checked before the abort was seen, so the try keeps its place: a resume corrects it.
    expect(placeOf(readBack(invalid.paths.result))).toEqual({
      outcome: 'error',
      try: 1,
      validationTry: 1,
      validationFailed: true,
    });
    expect(existsSync(s.dir(2))).toBe(false);

    const cut = new AbortController();
    const slow = recording(
      createFakeHarness({ script: { 'spec#2': [submits({ summary: 3 }, 0.125, { delayMs: 10_000 })] } }),
      { before: () => void setTimeout(() => cut.abort(), 20) },
    );
    const started = Date.now();
    const during = await runCall(s.request(specStep(), slow, { call: 2, signal: cut.signal }));
    expect(slow.requests).toHaveLength(1);
    const result = readBack(during.paths.result);
    expect(errorsOf(result)).toEqual([{ reason: 'harness', message: 'aborted' }]);
    expect(placeOf(result)).toEqual({ outcome: 'error', try: 1, validationTry: 1, validationFailed: false });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(s.dir(2, 2))).toBe(false);
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a call resumed after an invalid try and an interrupted correction keeps its one correction: the next try is its second validation, told the original problems, and its failure is final', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    const answers = [
      submits({ summary: 3 }, 0.125),
      submits(SPEC, 0.25, { delayMs: 10_000 }),
      submits({ summary: null }, 0.5),
      submits(SPEC, 1),
    ];
    const stopped = new AbortController();
    const interrupted = fake(answers, {
      before: (_, earlier) => void (earlier === 1 && setTimeout(() => stopped.abort(), 20)),
    });
    await runCall(s.request(specStep(), interrupted, { signal: stopped.signal }));

    expect(interrupted.requests.map((request) => request.try)).toEqual([1, 2]);
    const one = readBack(join(s.dir(1), 'result.json'));
    const two = readBack(join(s.dir(2), 'result.json'));
    expect([placeOf(one), placeOf(two)]).toEqual([
      { outcome: 'error', try: 1, validationTry: 1, validationFailed: true },
      { outcome: 'error', try: 2, validationTry: 2, validationFailed: false },
    ]);
    const original = errorsOf(one)[0] as ContractError;
    expect(original.message).toContain(NOT_A_STRING);
    // The interrupted try says what it was correcting, then how it ended.
    expect(errorsOf(two)).toEqual([original, { reason: 'harness', message: 'aborted' }]);

    const resumed = fake(answers);
    const second = await runCall(s.request(specStep(), resumed));
    expect(resumed.requests.map((request) => request.try)).toEqual([3]);
    const prompt = resumed.requests[0]?.prompt ?? '';
    expect([prompt.includes(original.message), prompt.includes('aborted')]).toEqual([true, false]);
    expect(second.paths.dir).toBe(s.dir(3));
    const three = readBack(second.paths.result);
    expect(placeOf(three)).toEqual({ outcome: 'error', try: 3, validationTry: 2, validationFailed: true });
    expect(errorsOf(three)).toEqual([
      original,
      { reason: 'invalid_output', message: expect.stringContaining('expected string, received null') },
    ]);

    // Its second failure awaits only the journal: another resume runs nothing, and returns it as it is.
    const again = fake(answers);
    const third = await runCall(s.request(specStep(), again));
    expect(again.requests).toEqual([]);
    expect(third.paths.dir).toBe(s.dir(3));
    expect(written(third.result)).toEqual(readBack(join(s.dir(3), 'result.json')));
    expect(existsSync(s.dir(4))).toBe(false);
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('an interruption before any output was checked does not use the correction', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    const answers = [
      submits({ summary: 3 }, 0.125, { delayMs: 10_000 }),
      submits({ summary: 3 }, 0.25),
      submits(SPEC, 0.5),
    ];
    const stopped = new AbortController();
    const interrupted = fake(answers, { before: () => void setTimeout(() => stopped.abort(), 20) });
    await runCall(s.request(specStep(), interrupted, { signal: stopped.signal }));

    expect(interrupted.requests.map((request) => request.try)).toEqual([1]);
    const one = readBack(join(s.dir(1), 'result.json'));
    expect(placeOf(one)).toEqual({ outcome: 'error', try: 1, validationTry: 1, validationFailed: false });
    expect(errorsOf(one)).toEqual([{ reason: 'harness', message: 'aborted' }]);

    const resumed = fake(answers);
    const { paths } = await runCall(s.request(specStep(), resumed));
    expect(resumed.requests.map((request) => request.try)).toEqual([2, 3]);
    expect([placeOf(readBack(join(s.dir(2), 'result.json'))), placeOf(readBack(paths.result))]).toEqual([
      { outcome: 'error', try: 2, validationTry: 1, validationFailed: true },
      { outcome: 'done', try: 3, validationTry: 2, validationFailed: false },
    ]);
    expect(paths.dir).toBe(s.dir(3));
    const [second = '', third = ''] = resumed.requests.map((request) => request.prompt);
    expect([second.includes(NOT_A_STRING), third.includes(NOT_A_STRING)]).toEqual([false, true]);
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a prior result that cannot be read fails the resumed call, naming it, and no session starts', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    const answers = [submits({ summary: 3 }, 0.125), submits(SPEC, 0.25)];
    const stopped = new AbortController();
    const first = fake(answers, { after: () => stopped.abort() });
    await runCall(s.request(specStep(), first, { signal: stopped.signal }));
    expect(first.requests).toHaveLength(1);

    // A torn result: its try may have used the correction, and nothing left says so.
    writeFileSync(join(s.dir(1), 'result.json'), '{\n  "schema": "sail.result.v1",\n  "outco');
    const resumed = fake(answers);
    await expect(runCall(s.request(specStep(), resumed))).rejects.toThrow('01-spec/call-1/result.json');
    expect(resumed.requests).toEqual([]);
    expect(existsSync(s.dir(2))).toBe(false);
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('the directory and the result of a try are synced to disk before the next session starts', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    // Every fsync, by the path its descriptor was opened on, and every rename: a file written under another name and
    // renamed is synced under the first.
    const synced: string[] = [];
    const renamed: [string, string][] = [];
    const opened = new Map<number, string>();
    const real = { open: fs.openSync, fsync: fs.fsyncSync, rename: fs.renameSync };
    const spies = [
      spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
        const fd = real.open(...args);
        opened.set(fd, String(args[0]));
        return fd;
      }),
      spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
        synced.push(opened.get(fd) ?? '');
        real.fsync(fd);
      }),
      spyOn(fs, 'renameSync').mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
        renamed.push([String(from), String(to)]);
        real.rename(from, to);
      }),
    ];
    /** Whether `path`'s bytes were synced, under its own name or the one it was renamed from. */
    const durable = (path: string): boolean =>
      synced.includes(path) || renamed.some(([from, to]) => to === path && synced.includes(from));

    let atSecond: { result: boolean; entries: boolean[]; text: string | null } | undefined;
    const harness = fake([submits({ summary: 3 }, 0.125), submits(SPEC, 0.25)], {
      before: (_, earlier) => {
        if (earlier !== 1) return;
        atSecond = {
          result: durable(join(s.dir(1), 'result.json')),
          // call-1/'s own entry, in its stage's directory, then the entry of its result.json.
          entries: [synced.includes(dirname(s.dir(1))), synced.includes(s.dir(1))],
          text: textAt(join(s.dir(1), 'result.json')),
        };
      },
    });
    let atEnd: boolean[] = [];
    try {
      await runCall(s.request(specStep(), harness));
      atEnd = [durable(join(s.dir(2), 'result.json')), synced.includes(s.dir(2))];
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(harness.requests).toHaveLength(2);
    expect(JSON.parse(atSecond?.text ?? '{}')).toMatchObject({ outcome: 'error', try: 1, validationFailed: true });
    expect({ result: atSecond?.result, entries: atSecond?.entries }).toEqual({ result: true, entries: [true, true] });
    expect(atEnd).toEqual([true, true]);
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a result whose stage:end was lost is ended once when the call is recovered, with no session and no usage counted again', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    const answers = [submits({ summary: 3 }, 0.125), submits({ summary: null }, 0.25)];
    const emit = stream(s.runDir);
    emit(runStart());
    const first = fake(answers);
    await runCall(s.request(specStep(), first, { emit }));
    expect(first.requests).toHaveLength(2);

    // A crash between result.json and its stage:end: the result is on disk, and the events stop short of the event.
    const whole = readEvents(s.runDir);
    expect(whole.at(-1)).toMatchObject({ type: 'stage:end', try: 2 });
    cutEventsAfter(s.runDir, (event) => event.seq === whole.length - 1);
    const final = readBack(join(s.dir(2), 'result.json'));

    const recovered = fake(answers);
    const second = await runCall(s.request(specStep(), recovered, { emit: stream(s.runDir) }));
    expect(recovered.requests).toEqual([]);
    expect(second.paths.dir).toBe(s.dir(2));
    expect(readEvents(s.runDir).slice(whole.length - 1)).toEqual([
      expect.objectContaining({
        type: 'stage:end',
        key: KEY,
        try: 2,
        outcome: 'error',
        resultPath: '01-spec/call-1/try-2/result.json',
        errors: errorsOf(final),
      }),
    ]);

    await runCall(s.request(specStep(), recovered, { emit: stream(s.runDir) }));
    const events = readEvents(s.runDir);
    expect([events.length, recovered.requests.length]).toEqual([whole.length, 0]);
    const summary = summarize(events);
    expect(summary?.calls.map((call) => [call.key, call.outcome])).toEqual([[KEY, 'error']]);
    expect(summary?.totals.usage).toEqual({ costUsd: 0.375 });
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a session a killed process left open is ended once when its call is recovered, with the last usage it had reported', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    const emit = stream(s.runDir);
    const tokens = (input: number, output: number) => ({ input, cacheRead: 0, cacheWrite: 0, output });
    // What a kill leaves of a try: its directory, a session that started and reported two turns, and no result.
    const left: NewEvent[] = [
      runStart(),
      { type: 'stage:start', key: KEY, stage: 'spec', call: 1, try: 1, kind: 'agent', consumed: {} },
      { type: 'harness:session_start', key: KEY, adapter: 'fake', sessionId: 'fake-session-spec-1', model: MODEL },
      { type: 'usage:update', key: KEY, turn: 1, tokens: tokens(100, 20), costUsdSoFar: 0.25 },
      { type: 'usage:update', key: KEY, turn: 2, tokens: tokens(200, 40), costUsdSoFar: 0.5 },
    ];
    for (const event of left) emit(event);
    mkdirSync(join(s.dir(1), 'in'), { recursive: true });

    const harness = fake([submits(SPEC, 1), submits(SPEC, 0.125)]);
    const { paths } = await runCall(s.request(specStep(), harness, { emit: stream(s.runDir) }));
    expect(harness.requests.map((request) => request.try)).toEqual([2]);
    // The kill used none of the correction: nothing the session submitted was ever checked.
    expect(placeOf(readBack(paths.result))).toEqual({
      outcome: 'done',
      try: 2,
      validationTry: 1,
      validationFailed: false,
    });

    const events = readEvents(s.runDir);
    const sessions = events.flatMap((event) => {
      if (event.type === 'harness:session_start') return [`start ${event.sessionId}`];
      return event.type === 'harness:session_end' ? [`end ${event.sessionId}`] : [];
    });
    expect(sessions).toEqual([
      'start fake-session-spec-1',
      'end fake-session-spec-1',
      'start fake-session-spec-1-try-2',
      'end fake-session-spec-1-try-2',
    ]);
    expect(sessionEnds(events)[0]).toMatchObject({
      key: KEY,
      outcome: 'error',
      reason: 'interrupted',
      turns: 2,
      toolCalls: 0,
      denials: 0,
      usage: { inputTokens: 200, outputTokens: 40, costUsd: 0.5 },
    });
    expect(summarize(events)?.totals.usage).toMatchObject({ inputTokens: 200, outputTokens: 40, costUsd: 0.625 });
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a session whose end the events file lost is ended from its durable result, once, however often the call is recovered', async () => {
  await withTempRepo(async (repo) => {
    const s = specStage(repo);
    const answers = [submits({ summary: 3 }, 0.125), submits({ summary: null }, 0.25)];
    const emit = stream(s.runDir);
    emit(runStart());
    const first = fake(answers);
    await runCall(s.request(specStep(), first, { emit }));
    expect(first.requests).toHaveLength(2);

    // A power loss once the second session had started: its result reached the disk, and the tail of the events didn't.
    cutEventsAfter(s.runDir, (event) => event.type === 'harness:session_start');
    const kept = readEvents(s.runDir).length;
    expect(sessionEnds(readEvents(s.runDir))).toHaveLength(1);

    const recovered = fake(answers);
    const second = await runCall(s.request(specStep(), recovered, { emit: stream(s.runDir) }));
    expect(recovered.requests).toEqual([]);
    expect(second.paths.dir).toBe(s.dir(2));
    const appended = readEvents(s.runDir).slice(kept);
    expect(appended.map((event) => event.type).sort()).toEqual(['harness:session_end', 'stage:end']);
    expect(sessionEnds(appended)).toEqual([
      expect.objectContaining({
        key: KEY,
        sessionId: 'fake-session-spec-1-try-2',
        turns: 1,
        toolCalls: 0,
        denials: 0,
        usage: { costUsd: 0.25 },
      }),
    ]);

    await runCall(s.request(specStep(), recovered, { emit: stream(s.runDir) }));
    const events = readEvents(s.runDir);
    expect([events.length, recovered.requests.length]).toEqual([kept + 2, 0]);
    const summary = summarize(events);
    expect(summary?.calls.map((call) => [call.key, call.outcome])).toEqual([[KEY, 'error']]);
    expect(summary?.totals.usage).toEqual({ costUsd: 0.375 });
  });
});
