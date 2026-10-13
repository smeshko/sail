import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { callPaths, createCallDir } from '../../src/engine/call-dir';
import type { CallEvent } from '../../src/events/types';
import { KINDS, type StepContext, type StepRun } from '../../src/kinds/index';
import { BIN_DIR, DEFAULT_TIMEOUT_SECONDS, exitCodeMap, lastLine, scriptKind } from '../../src/kinds/script';
import { type ExitCodes, type ScriptStep, script, z } from '../../src/sdk/index';
import { steppingClock } from '../helpers/clock';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RUN_ID = 'tests-01ARYZ6S410000000000000000';

const TestReport = z.object({
  ok: z.boolean(),
  total: z.number().int(),
  failed: z.number().int(),
  durationMs: z.number().int(),
  failures: z.array(z.object({ test: z.string(), file: z.string(), message: z.string() })),
});

const PASSING = '{"ok":true,"total":1,"failed":0,"durationMs":5,"failures":[]}';
const FAILING =
  '{"ok":false,"total":1,"failed":1,"durationMs":5,"failures":[{"test":"t","file":"a.test.ts","message":"boom"}]}';
const JUNIT = 'echo "<testsuites/>" > "$STAGE_OUT/junit.xml"';

interface Setup {
  workspace: string;
  context: StepContext;
  /** Writes `run.sh` in the stage directory. */
  run: (body: string) => void;
}

/** A workspace holding `.sail/stages/tests/`, and a fresh call directory under `.sail-runs/`. */
function setup(): Setup {
  const workspace = mkdtempSync(join(tmpdir(), 'sail-script-'));
  dirs.push(workspace);
  const stageDir = join(workspace, '.sail', 'stages', 'tests');
  mkdirSync(stageDir, { recursive: true });
  const runDir = join(workspace, '.sail-runs', RUN_ID);
  const paths = callPaths(runDir, 0, 'tests', 1);
  createCallDir(paths);
  const context: StepContext = {
    runId: RUN_ID,
    runDir,
    stage: 'tests',
    call: 1,
    try: 1,
    stageDir,
    workspace,
    config: join(workspace, '.sail', 'project.yaml'),
    paths,
    inputs: {},
    graceMs: 200,
  };
  return {
    workspace,
    context,
    run: (body) => {
      writeFileSync(join(stageDir, 'run.sh'), `#!/bin/bash\n${body}\n`);
      chmodSync(join(stageDir, 'run.sh'), 0o755);
    },
  };
}

const tests = (options: { exitCodes?: ExitCodes; timeoutSeconds?: number; run?: string } = {}): ScriptStep =>
  script('tests', { run: './run.sh', produces: { 'junit.xml': 'file' }, output: TestReport, ...options });

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

/**
 * A step's run with its recorded `env` cut down to the preamble's variables: `SAIL_EVENTS`, which the script kind adds
 * after them, has cases of its own.
 */
function preambleOnly(run: StepRun): StepRun {
  const { SAIL_EVENTS: _events, ...env } = run.record.env as Record<string, string>;
  return { ...run, record: { ...run.record, env } };
}

test('KINDS holds the script kind', () => {
  expect(KINDS.script).toBe(scriptKind);
  expect(scriptKind.kind).toBe('script');
  expect(DEFAULT_TIMEOUT_SECONDS).toBe(600);
});

test('exit 0 is passed, with the parsed report and junit.xml recorded', async () => {
  const s = setup();
  s.run(`${JUNIT}\necho 'running 1 test'\necho '${PASSING}'`);
  const run = await scriptKind.run(tests(), s.context);
  expect(preambleOnly(run)).toEqual({
    outcome: 'passed',
    output: JSON.parse(PASSING),
    files: {
      'junit.xml': { path: '00-tests/call-1/junit.xml', bytes: 14, sha256: sha256('<testsuites/>\n') },
    },
    errors: [],
    record: {
      exit: { code: 0, mapped: 'passed' },
      command: '.sail/stages/tests/run.sh',
      env: {
        RUN_ID,
        STAGE: 'tests',
        CALL: '1',
        TRY: '1',
        STAGE_IN: `.sail-runs/${RUN_ID}/00-tests/call-1/in`,
        STAGE_OUT: `.sail-runs/${RUN_ID}/00-tests/call-1`,
        WORKSPACE: '.',
        SAIL_CONFIG: '.sail/project.yaml',
      },
    },
  });
});

test('exit 1 is failed, still with its report and junit.xml', async () => {
  const s = setup();
  s.run(`${JUNIT}\necho '${FAILING}'\nexit 1`);
  const run = await scriptKind.run(tests(), s.context);
  expect(run).toMatchObject({ outcome: 'failed', output: JSON.parse(FAILING), errors: [] });
  expect(run.files['junit.xml']).toBeDefined();
  expect(run.record.exit).toEqual({ code: 1, mapped: 'failed' });
});

test('a last line that is not JSON is invalid_output, with the parse error', async () => {
  const s = setup();
  s.run(`${JUNIT}\necho '${PASSING}'\necho 'not json'`);
  const run = await scriptKind.run(tests(), s.context);
  expect(run).toMatchObject({ outcome: 'error', output: null });
  expect(run.errors).toHaveLength(1);
  expect(run.errors[0]?.reason).toBe('invalid_output');
  expect(run.errors[0]?.message).toStartWith('the last stdout line is not JSON: ');
  expect(run.errors[0]?.message.length).toBeGreaterThan('the last stdout line is not JSON: '.length);
});

test('empty stdout is invalid_output', async () => {
  const s = setup();
  s.run(JUNIT);
  expect((await scriptKind.run(tests(), s.context)).errors).toEqual([
    { reason: 'invalid_output', message: 'stdout is empty; the last line must be the JSON output' },
  ]);
});

test("a report of the wrong shape is invalid_output, with Zod's message", async () => {
  const s = setup();
  s.run(`${JUNIT}\necho '{"ok":true,"failed":0,"durationMs":5,"failures":[]}'`);
  const run = await scriptKind.run(tests(), s.context);
  expect(run.outcome).toBe('error');
  expect(run.errors).toEqual([
    {
      reason: 'invalid_output',
      message:
        "the output doesn't match its schema:\n✖ Invalid input: expected number, received undefined\n  → at total",
    },
  ]);
});

test('a missing declared file is missing_file, and a bad last line with it gives both errors', async () => {
  const s = setup();
  s.run(`echo '${PASSING}'`);
  expect(await scriptKind.run(tests(), s.context)).toMatchObject({
    outcome: 'error',
    output: null,
    files: {},
    errors: [{ reason: 'missing_file', message: "'junit.xml' was not produced in $STAGE_OUT" }],
  });
  const both = setup();
  both.run("echo 'not json'");
  expect((await scriptKind.run(tests(), both.context)).errors.map((error) => error.reason)).toEqual([
    'invalid_output',
    'missing_file',
  ]);
});

test('failed with a missing file is error', async () => {
  const s = setup();
  s.run(`echo '${FAILING}'\nexit 1`);
  const run = await scriptKind.run(tests(), s.context);
  expect(run).toMatchObject({ outcome: 'error', output: null });
  expect(run.errors.map((error) => error.reason)).toEqual(['missing_file']);
  expect(run.record.exit).toEqual({ code: 1, mapped: 'failed' });
});

test('an unmapped exit code is exit_code, and nothing else is checked', async () => {
  const s = setup();
  s.run('exit 2');
  expect(await scriptKind.run(tests(), s.context)).toMatchObject({
    outcome: 'error',
    output: null,
    errors: [{ reason: 'exit_code', message: 'exit code 2 is not mapped to passed or failed' }],
    record: { exit: { code: 2, mapped: 'error' } },
  });
});

test('exitCodes fills the lists it leaves out, and a code listed under error is exit_code', async () => {
  const s = setup();
  s.run(`${JUNIT}\necho '${FAILING}'\nexit 2`);
  expect(await scriptKind.run(tests({ exitCodes: { failed: [1, 2] } }), s.context)).toMatchObject({
    outcome: 'failed',
    record: { exit: { code: 2, mapped: 'failed' } },
  });
  const zero = setup();
  zero.run(`${JUNIT}\necho '${PASSING}'`);
  expect((await scriptKind.run(tests({ exitCodes: { failed: [1, 2] } }), zero.context)).outcome).toBe('passed');
  const listed = setup();
  listed.run('exit 3');
  expect((await scriptKind.run(tests({ exitCodes: { error: [3] } }), listed.context)).errors).toEqual([
    { reason: 'exit_code', message: 'exit code 3 is not mapped to passed or failed' },
  ]);
  expect(exitCodeMap(tests())).toEqual({ passed: [0], failed: [1], error: [] });
});

test('a timeout is error, with the signal that ended the script and no output', async () => {
  const s = setup();
  s.run('sleep 5');
  const started = performance.now();
  const run = await scriptKind.run(tests({ timeoutSeconds: 1 }), s.context);
  console.log(`timeout: ${Math.round(performance.now() - started)} ms`);
  expect(run).toMatchObject({
    outcome: 'error',
    output: null,
    errors: [{ reason: 'timeout', message: 'timed out after 1s' }],
    record: { exit: { code: null, signal: 'SIGTERM' } },
  });
  expect(performance.now() - started).toBeLessThan(3500);
});

test('a script killed by a signal is exit_code, naming the signal', async () => {
  const s = setup();
  s.run('kill -KILL $$');
  expect(await scriptKind.run(tests(), s.context)).toMatchObject({
    outcome: 'error',
    errors: [{ reason: 'exit_code', message: 'ended by signal SIGKILL' }],
    record: { exit: { code: null, signal: 'SIGKILL' } },
  });
});

test('an interrupted script is error, even when it handles SIGTERM, leaves its report and exits 0', async () => {
  const s = setup();
  s.run(
    `finish() {\n  ${JUNIT}\n  echo '${PASSING}'\n  exit 0\n}\n` +
      'trap finish TERM\ntouch "$STAGE_OUT/ready"\nwhile :; do sleep 0.05; done',
  );
  const controller = new AbortController();
  const running = scriptKind.run(tests(), { ...s.context, signal: controller.signal });
  // Aborted once the trap is set, not after a fixed delay: a script's first exec can be slow.
  while (!existsSync(join(s.context.paths.dir, 'ready'))) await Bun.sleep(20);
  controller.abort();
  const run = await running;
  expect(run).toMatchObject({
    outcome: 'error',
    output: null,
    files: {},
    errors: [{ reason: 'exit_code', message: 'interrupted, then exited with code 0' }],
    record: { exit: { code: 0, mapped: 'passed' } },
  });
  expect(readFileSync(s.context.paths.stdout, 'utf8')).toBe(`${PASSING}\n`);
});

test('a script that clears $STAGE_OUT removes its log, and ends invalid_output', async () => {
  const s = setup();
  s.run(`rm -rf "$STAGE_OUT"/*\n${JUNIT}\necho '${PASSING}'`);
  const run = await scriptKind.run(tests(), s.context);
  expect(run).toMatchObject({
    outcome: 'error',
    output: null,
    errors: [
      { reason: 'invalid_output', message: "stdout.log was removed from $STAGE_OUT, so the output can't be read" },
    ],
  });
  expect(Object.keys(run.files)).toEqual(['junit.xml']);
});

test.skipIf(process.getuid?.() === 0)('a log the script leaves unreadable is invalid_output, naming why', async () => {
  const s = setup();
  s.run(`${JUNIT}\necho '${PASSING}'\nchmod 000 "$STAGE_OUT/stdout.log"`);
  expect(await scriptKind.run(tests(), s.context)).toMatchObject({
    outcome: 'error',
    errors: [{ reason: 'invalid_output', message: "stdout.log can't be read (EACCES), so the output can't be either" }],
  });
});

test('a log the script leaves a symlink loop is invalid_output, and script:exit counts no bytes', async () => {
  const s = setup();
  s.run(`${JUNIT}\necho '${PASSING}'\nrm "$STAGE_OUT/stdout.log"\nln -s stdout.log "$STAGE_OUT/stdout.log"`);
  const { context, events } = collecting(s);
  expect(await scriptKind.run(tests(), context)).toMatchObject({
    outcome: 'error',
    errors: [{ reason: 'invalid_output', message: "stdout.log can't be read (ELOOP), so the output can't be either" }],
  });
  expect(events.map((event) => event.type)).toEqual(['script:exec', 'script:exit', 'output:invalid', 'file:produced']);
  expect(events[1]).toMatchObject({ code: 0, stdoutBytes: 0 });
});

test('a script that is missing is not_started, with no exit', async () => {
  const s = setup();
  const run = await scriptKind.run(tests({ run: './missing.sh' }), s.context);
  expect(run).toMatchObject({ outcome: 'error', output: null, files: {} });
  expect(run.errors).toHaveLength(1);
  expect(run.errors[0]?.reason).toBe('not_started');
  expect(run.record.exit).toBeUndefined();
  expect(run.record.command).toBe('.sail/stages/tests/missing.sh');
});

test('the script sees the whole preamble, inherits the environment, and runs from the workspace', async () => {
  const s = setup();
  const spec = join(s.context.paths.stageIn, 'spec.md');
  writeFileSync(spec, '# spec\n');
  const context = { ...s.context, inputs: { INPUT_SPEC: spec } };
  const names = ['RUN_ID', 'STAGE', 'CALL', 'TRY', 'STAGE_IN', 'STAGE_OUT', 'WORKSPACE', 'SAIL_CONFIG', 'INPUT_SPEC'];
  writeFileSync(
    join(context.stageDir, 'env.ts'),
    `#!${process.execPath}\n` +
      `const env = Object.fromEntries(${JSON.stringify(names)}.map((name) => [name, process.env[name] ?? '']));\n` +
      `console.log(JSON.stringify({ ...env, CWD: process.cwd(), HAS_PATH: String(process.env.PATH !== undefined) }));\n`,
  );
  chmodSync(join(context.stageDir, 'env.ts'), 0o755);
  const step = script('env', { run: './env.ts', output: z.record(z.string(), z.string()) });
  const run = await scriptKind.run(step, context);
  expect(run.errors).toEqual([]);
  expect(run.output).toEqual({
    RUN_ID,
    STAGE: 'tests',
    CALL: '1',
    TRY: '1',
    STAGE_IN: context.paths.stageIn,
    STAGE_OUT: context.paths.dir,
    WORKSPACE: s.workspace,
    SAIL_CONFIG: context.config,
    INPUT_SPEC: spec,
    CWD: realpathSync(s.workspace),
    HAS_PATH: 'true',
  });
  expect(Object.keys(preambleOnly(run).record.env as object)).toEqual(names);
  expect((run.record.env as Record<string, string>).INPUT_SPEC).toBe(`.sail-runs/${RUN_ID}/00-tests/call-1/in/spec.md`);
});

test('a script on a later try sees TRY as that try', async () => {
  const s = setup();
  s.run('echo "{\\"try\\":\\"$TRY\\"}"');
  const step = script('tests', { run: './run.sh', output: z.object({ try: z.string() }) });
  const run = await scriptKind.run(step, { ...s.context, try: 3 });
  expect(run.output).toEqual({ try: '3' });
  expect((run.record.env as Record<string, string>).TRY).toBe('3');
});

test('problems() reports overlapping exit codes, a produced name that is reserved or not plain, and a timeout that is not positive', () => {
  expect(scriptKind.problems(tests())).toEqual([]);
  expect(scriptKind.problems(tests({ exitCodes: { passed: [0], failed: [0, 1], error: [1] } }))).toEqual([
    'exit code 0 is listed under both passed and failed',
    'exit code 1 is listed under both failed and error',
  ]);
  expect(scriptKind.problems(tests({ exitCodes: { failed: [0] } }))).toEqual([
    'exit code 0 is listed under both passed and failed',
  ]);
  const reserved = script('tests', {
    run: './run.sh',
    produces: { 'stdout.log': 'file', in: 'file' },
    output: TestReport,
  });
  expect(scriptKind.problems(reserved)).toEqual([
    "'stdout.log' can't be produced: the engine writes it in $STAGE_OUT",
    "'in' can't be produced: the engine writes it in $STAGE_OUT",
  ]);
  const escaping = script('tests', { run: './run.sh', produces: { '../junit.xml': 'file' }, output: TestReport });
  expect(scriptKind.problems(escaping)).toEqual(["'../junit.xml' can't be produced: it is not a plain file name"]);
  for (const timeoutSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(scriptKind.problems(tests({ timeoutSeconds }))).toEqual([
      `timeoutSeconds must be a positive number: ${timeoutSeconds}`,
    ]);
  }
});

test('lastLine finds a 200 KiB last line whole, and skips trailing blank lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sail-last-line-'));
  dirs.push(dir);
  const path = join(dir, 'stdout.log');
  const long = `{"blob":"${'é'.repeat(100 * 1024)}"}`;
  writeFileSync(path, `first\nsecond\n${long}\n\n  \n\r\n`);
  expect(lastLine(path)).toBe(long);
  writeFileSync(path, 'only');
  expect(lastLine(path)).toBe('only');
  writeFileSync(path, 'a\nb\r\n');
  expect(lastLine(path)).toBe('b');
  writeFileSync(path, '');
  expect(lastLine(path)).toBeUndefined();
  writeFileSync(path, '\n \n\t\n');
  expect(lastLine(path)).toBeUndefined();
});

/** The setup's context with an emitter that keeps every event the step reports. */
function collecting(s: Setup): { context: StepContext; events: CallEvent[] } {
  const events: CallEvent[] = [];
  return { context: { ...s.context, emit: (event) => events.push(event) }, events };
}

test('a script that is missing reports script:exec, and nothing more', async () => {
  const s = setup();
  const { context, events } = collecting(s);
  await scriptKind.run(tests({ run: './missing.sh' }), context);
  const [exec, ...more] = events;
  expect(more).toEqual([]);
  expect(exec).toMatchObject({ type: 'script:exec', command: '.sail/stages/tests/missing.sh', cwd: '.' });
  // The preamble's names, in order. The one the script kind adds after them has a case of its own.
  const envKeys = exec?.type === 'script:exec' ? exec.envKeys : [];
  expect(envKeys.filter((name) => name !== 'SAIL_EVENTS')).toEqual([
    'RUN_ID',
    'STAGE',
    'CALL',
    'TRY',
    'STAGE_IN',
    'STAGE_OUT',
    'WORKSPACE',
    'SAIL_CONFIG',
  ]);
});

test('an unmapped exit code reports script:exit with outcome error, and nothing about the output', async () => {
  const s = setup();
  s.run('exit 2');
  const { context, events } = collecting(s);
  await scriptKind.run(tests(), context);
  expect(events.map((event) => event.type)).toEqual(['script:exec', 'script:exit']);
  expect(events[1]).toMatchObject({ code: 2, outcome: 'error', durationMs: expect.any(Number), stdoutBytes: 0 });
});

test('a declared file that is missing reports no file:produced, while the output is still validated', async () => {
  const s = setup();
  s.run(`echo '${PASSING}'`);
  const { context, events } = collecting(s);
  await scriptKind.run(tests(), context);
  expect(events.map((event) => event.type)).toEqual(['script:exec', 'script:exit', 'output:validated']);
  expect(events[1]).toMatchObject({ code: 0, outcome: 'passed', stdoutBytes: PASSING.length + 1 });
});

test('problems() refuses a script that would produce prompt.md or session.log: the engine writes both, whatever the kind', () => {
  const reserved = script('tests', {
    run: './run.sh',
    produces: { 'prompt.md': 'file', 'session.log': 'file', 'notes.md': 'file' },
    output: TestReport,
  });
  expect(scriptKind.problems(reserved)).toEqual([
    "'prompt.md' can't be produced: the engine writes it in $STAGE_OUT",
    "'session.log' can't be produced: the engine writes it in $STAGE_OUT",
  ]);
});

const HOUR_MS = 3_600_000;
/** A run's clock that jumps an hour at every reading: nothing that waits may read it. */
const jumping = () => steppingClock('2026-09-25T09:00:00.000Z', HOUR_MS);

test("script:exit's duration is two readings of the run's clock apart, and a clock that jumps an hour times no script out", async () => {
  const s = setup();
  s.run(`${JUNIT}\necho '${PASSING}'`);
  const { context, events } = collecting(s);
  const run = await scriptKind.run(tests({ timeoutSeconds: 5 }), { ...context, clock: jumping() });
  expect(events.find((event) => event.type === 'script:exit')).toMatchObject({
    code: 0,
    outcome: 'passed',
    durationMs: HOUR_MS,
  });
  expect(events.map((event) => event.type)).toEqual([
    'script:exec',
    'script:exit',
    'output:validated',
    'file:produced',
  ]);
  expect([run.outcome, run.errors]).toEqual(['passed', []]);
});

test('a clock that jumps an hour at every reading stretches no grace period', async () => {
  const s = setup();
  s.run('trap "" TERM\ntouch "$STAGE_OUT/ready"\nwhile :; do sleep 0.05; done');
  const { context, events } = collecting(s);
  const controller = new AbortController();
  const running = scriptKind.run(tests(), { ...context, signal: controller.signal, clock: jumping() });
  while (!existsSync(join(s.context.paths.dir, 'ready'))) await Bun.sleep(20);
  const aborted = performance.now();
  controller.abort();
  const run = await running;
  const stopped = performance.now() - aborted;
  expect(events.find((event) => event.type === 'script:exit')).toMatchObject({
    code: null,
    signal: 'SIGKILL',
    durationMs: HOUR_MS,
  });
  expect(run.errors).toEqual([{ reason: 'exit_code', message: 'interrupted, then ended by signal SIGKILL' }]);
  // The context's grace period is 200 ms of real time.
  expect(stopped).toBeLessThan(2000);
});

// sail on a script step's PATH (D13).

const ROOT = join(import.meta.dir, '..', '..');
/** Prints what `sail` is inside the step: its version, where the shell found it, the head of PATH and the rest of it. */
const WHICH_SAIL =
  'printf \'{"version":"%s","path":"%s","first":"%s","rest":"%s","bun":"%s"}\\n\' "$(sail --version)" ' +
  '"$(command -v sail)" "$(printf %s "$PATH" | cut -d: -f1)" "$(printf %s "$PATH" | cut -d: -f2-)" "$SAIL_BUN"';
const Which = z.object({ version: z.string(), path: z.string(), first: z.string(), rest: z.string(), bun: z.string() });

test("sail inside a script step is this checkout's, on the running Bun: PATH starts with its bin/, ahead of the PATH the engine has, and neither PATH nor SAIL_BUN is recorded", async () => {
  const s = setup();
  s.run(WHICH_SAIL);
  const { context, events } = collecting(s);
  const run = await scriptKind.run(script('tests', { run: './run.sh', output: Which }), context);
  expect(run.errors).toEqual([]);
  expect(run.output).toEqual({
    version: pkg.version,
    path: join(ROOT, 'bin', 'sail'),
    first: join(ROOT, 'bin'),
    rest: process.env.PATH ?? '',
    bun: process.execPath,
  });
  expect(BIN_DIR).toBe(join(ROOT, 'bin'));
  const recorded = Object.keys(run.record.env as object);
  const [exec] = events.flatMap((event) => (event.type === 'script:exec' ? [event.envKeys] : []));
  expect([recorded.includes('PATH'), recorded.includes('SAIL_BUN')]).toEqual([false, false]);
  expect([exec?.includes('PATH'), exec?.includes('SAIL_BUN')]).toEqual([false, false]);
});

// A script's port events (D12): what a `sail port` under the step leaves in `$SAIL_EVENTS` joins the step's events once
// the script has ended.

const PORT_EVENTS = 'port-events.ndjson';
const PUSHED = { type: 'codehost:pushed', branch: 'sail/FAKE-1', headSha: 'a'.repeat(40) } as const;
const LABELLED = { type: 'codehost:labelled', number: 5, label: 'sail', change: 'added' } as const;
/** A script line that appends `event` to the port events file, as a `sail port` would. */
const reports = (event: object) => `echo '${JSON.stringify(event)}' >> "$SAIL_EVENTS"`;
const typesOf = (events: readonly CallEvent[]) => events.map((event) => event.type);

const PROJECT = `name: script-kind
sail: ">=0.0.0 <1"
adapters:
  ticketSource: { use: fake }
  codeHost: { use: fake }
  harness: { use: fake }
  workspace: { use: fake }
`;
const TICKET = {
  ticketKey: 'FAKE-1',
  title: 'Add a greeting',
  description: 'Greet the user by name.',
  state: { type: 'unstarted', name: 'Todo' },
  labels: ['sail'],
  comments: [],
  links: [],
  attachments: [],
};

/** Gives the setup's `.sail/` a config and a ticket, so `sail port ticket-source get FAKE-1` in its script answers. */
function withTicket(s: Setup): void {
  const sail = join(s.workspace, '.sail');
  writeFileSync(join(sail, 'project.yaml'), PROJECT);
  mkdirSync(join(sail, 'fake'));
  writeFileSync(join(sail, 'fake', 'tickets.json'), JSON.stringify({ tickets: [TICKET] }));
}

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('SAIL_EVENTS names port-events.ndjson in the call directory: it is recorded relative to the workspace and listed last in envKeys, and a script that calls no port leaves no file', async () => {
  const s = setup();
  s.run(`${JUNIT}\nprintf '%s' "\${SAIL_EVENTS:-unset}" > "$STAGE_OUT/named"\necho '${PASSING}'`);
  const { context, events } = collecting(s);
  const run = await scriptKind.run(tests(), context);
  const file = join(s.context.paths.dir, PORT_EVENTS);
  expect(readFileSync(join(s.context.paths.dir, 'named'), 'utf8')).toBe(file);
  const env = run.record.env as Record<string, string>;
  expect([env.SAIL_EVENTS, Object.keys(env).at(-1)]).toEqual([
    `.sail-runs/${RUN_ID}/00-tests/call-1/${PORT_EVENTS}`,
    'SAIL_EVENTS',
  ]);
  expect(events[0]).toMatchObject({
    type: 'script:exec',
    envKeys: ['RUN_ID', 'STAGE', 'CALL', 'TRY', 'STAGE_IN', 'STAGE_OUT', 'WORKSPACE', 'SAIL_CONFIG', 'SAIL_EVENTS'],
  });
  expect(existsSync(file)).toBe(false);
  expect(typesOf(events)).toEqual(['script:exec', 'script:exit', 'output:validated', 'file:produced']);
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a script that runs sail port has its provider event emitted between script:exec and script:exit, and the file stays in the call directory, holding what the child wrote', async () => {
  const s = setup();
  withTicket(s);
  s.run(`sail port ticket-source get FAKE-1 >/dev/null\n${JUNIT}\necho '${PASSING}'`);
  const { context, events } = collecting(s);
  const run = await scriptKind.run(tests(), context);
  expect(typesOf(events)).toEqual([
    'script:exec',
    'ticket:fetched',
    'script:exit',
    'output:validated',
    'file:produced',
  ]);
  expect(events[1]).toMatchObject({ ticketKey: 'FAKE-1', comments: 0, links: 0, attachments: 0 });
  expect([run.outcome, run.errors]).toEqual(['passed', []]);
  const lines = readFileSync(join(s.context.paths.dir, PORT_EVENTS), 'utf8').split('\n');
  expect(lines.map((line) => (line === '' ? '' : JSON.parse(line)))).toEqual([events[1], '']);
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  .each<[string, string, number | undefined, string, string[]]>([
  ['times out', 'sleep 5', 1, 'error', ['script:exec', 'codehost:pushed', 'script:exit', 'error:timeout']],
  [
    'exits with a failing code',
    `${JUNIT}\necho '${FAILING}'\nexit 1`,
    undefined,
    'failed',
    ['script:exec', 'codehost:pushed', 'script:exit', 'output:validated', 'file:produced'],
  ],
  [
    'is interrupted',
    'touch "$STAGE_OUT/ready"\nwhile :; do sleep 0.05; done',
    undefined,
    'error',
    ['script:exec', 'codehost:pushed', 'script:exit'],
  ],
])(
  'a script that reports a provider event and then %s has it emitted before script:exit',
  async (how, body, timeoutSeconds, outcome, types) => {
    const s = setup();
    s.run(`${reports(PUSHED)}\n${body}`);
    const { context, events } = collecting(s);
    const controller = new AbortController();
    const step = tests(timeoutSeconds === undefined ? {} : { timeoutSeconds });
    const running = scriptKind.run(step, { ...context, signal: controller.signal });
    if (how === 'is interrupted') {
      while (!existsSync(join(s.context.paths.dir, 'ready'))) await Bun.sleep(20);
      controller.abort();
    }
    const run = await running;
    expect<string[]>(typesOf(events)).toEqual(types);
    expect<unknown>(events[1]).toEqual(PUSHED);
    expect(run.outcome).toBe(outcome);
  },
);

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a line of the port events file that is no provider event ends the step in error with the reason port, and the valid lines before and after it are emitted', async () => {
  const s = setup();
  s.run(
    `${reports(PUSHED)}\necho 'opened a pull request' >> "$SAIL_EVENTS"\n${reports(LABELLED)}\n${JUNIT}\necho '${PASSING}'`,
  );
  const { context, events } = collecting(s);
  const run = await scriptKind.run(tests(), context);
  expect(typesOf(events)).toEqual([
    'script:exec',
    'codehost:pushed',
    'codehost:labelled',
    'script:exit',
    'output:validated',
    'file:produced',
  ]);
  expect(run).toMatchObject({
    outcome: 'error',
    output: null,
    errors: [{ reason: 'port', message: 'port-events.ndjson line 2 is not a provider event: it is not JSON' }],
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a bad line joins the errors the step already has: a script that timed out, or left a declared file out, has both', async () => {
  const forged = { type: 'run:end', status: 'completed', replays: 1 };
  const port = {
    reason: 'port' as const,
    message: 'port-events.ndjson line 1 is not a provider event: its type "run:end" is no ticket:* or codehost:* event',
  };
  const timedOut = setup();
  timedOut.run(`${reports(forged)}\nsleep 5`);
  expect((await scriptKind.run(tests({ timeoutSeconds: 1 }), timedOut.context)).errors).toEqual([
    { reason: 'timeout', message: 'timed out after 1s' },
    port,
  ]);
  const noFile = setup();
  noFile.run(`${reports(forged)}\necho '${PASSING}'`);
  expect(await scriptKind.run(tests(), noFile.context)).toMatchObject({
    outcome: 'error',
    errors: [{ reason: 'missing_file', message: "'junit.xml' was not produced in $STAGE_OUT" }, port],
  });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ("a last line with no newline is dropped, and the step's outcome is what it would have been", async () => {
  const s = setup();
  s.run(`${reports(PUSHED)}\nprintf '%s' '${JSON.stringify(LABELLED)}' >> "$SAIL_EVENTS"\n${JUNIT}\necho '${PASSING}'`);
  const { context, events } = collecting(s);
  const run = await scriptKind.run(tests(), context);
  expect(typesOf(events)).toEqual([
    'script:exec',
    'codehost:pushed',
    'script:exit',
    'output:validated',
    'file:produced',
  ]);
  expect([run.outcome, run.errors]).toEqual(['passed', []]);
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a script that removes the file after reporting emits nothing for it, and has no error from it', async () => {
  const s = setup();
  s.run(
    `${reports(PUSHED)}\nif [ -f "\${SAIL_EVENTS:-unset}" ]; then had=true; else had=false; fi\n` +
      'rm -f "$SAIL_EVENTS"\necho "{\\"had\\":$had}"',
  );
  const { context, events } = collecting(s);
  const step = script('tests', { run: './run.sh', output: z.object({ had: z.boolean() }) });
  const run = await scriptKind.run(step, context);
  expect(run).toMatchObject({ outcome: 'passed', output: { had: true }, errors: [] });
  expect(typesOf(events)).toEqual(['script:exec', 'script:exit', 'output:validated']);
});
