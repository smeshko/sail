// The script step's contract end to end: runCall() in a temporary repository, each result.json read back from disk.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Supplied } from '../../src/engine/bindings';
import { type CallRequest, callProblems, runCall } from '../../src/engine/call';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import type { Emit, NewEvent } from '../../src/events/types';
import { agent, file, type StageDefinition, script, stage, value, z } from '../../src/sdk/index';
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

test('an agent step or a multi-step stage is refused, and gets no call directory', async () => {
  await withTempRepo(async (repo) => {
    const s = tests(repo);
    expect(callProblems(spec, {})).toEqual(["agent steps can't run yet"]);
    expect(callProblems(twoSteps, {})).toEqual(["multi-step stages can't run yet"]);
    await expect(runCall(s.request(spec))).rejects.toThrow("agent steps can't run yet");
    await expect(runCall(s.request(twoSteps))).rejects.toThrow("multi-step stages can't run yet");
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
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

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a passing call reports its events in order, each keyed by its call', async () => {
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

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('each bound binding reports where it came from, in the order the stage declares them, and an unbound one nothing', async () => {
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

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ("an output that breaks its schema reports output:invalid with the contract's message, and stage:end its errors", async () => {
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

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a timeout reports the signal and error:timeout, and nothing about output or files', async () => {
    await withTempRepo(async (repo) => {
      const s = tests(repo);
      s.run('sleep 5');
      const { events, emit } = collect();
      await runCall({ ...s.request(plainStep({ timeoutSeconds: 1 })), emit });

      expect(types(events)).toEqual(['stage:start', 'script:exec', 'script:exit', 'error:timeout', 'stage:end']);
      expect(events[2]).toMatchObject({ type: 'script:exit', code: null, signal: 'SIGTERM' });
      expect(events[2]).not.toHaveProperty('outcome');
      expect(events[3]).toEqual({ type: 'error:timeout', key: 'tests#1', message: 'timed out after 1s', timeoutSeconds: 1 });
      expect(events[4]).toMatchObject({ outcome: 'error', errors: [{ reason: 'timeout', message: 'timed out after 1s' }] });
      checkStamped(events);
    });
  });

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ("a later try reports its try, under its call's key", async () => {
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
