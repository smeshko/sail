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
import { callPaths, createCallDir } from '../../src/engine/call-dir';
import { KINDS, type StepContext } from '../../src/kinds/index';
import { DEFAULT_TIMEOUT_SECONDS, exitCodeMap, lastLine, scriptKind } from '../../src/kinds/script';
import { type ExitCodes, type ScriptStep, script, z } from '../../src/sdk/index';

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

test('KINDS holds the script kind', () => {
  expect(KINDS.script).toBe(scriptKind);
  expect(scriptKind.kind).toBe('script');
  expect(DEFAULT_TIMEOUT_SECONDS).toBe(600);
});

test('exit 0 is passed, with the parsed report and junit.xml recorded', async () => {
  const s = setup();
  s.run(`${JUNIT}\necho 'running 1 test'\necho '${PASSING}'`);
  const run = await scriptKind.run(tests(), s.context);
  expect(run).toEqual({
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
  expect(Object.keys(run.record.env as object)).toEqual(names);
  expect((run.record.env as Record<string, string>).INPUT_SPEC).toBe(`.sail-runs/${RUN_ID}/00-tests/call-1/in/spec.md`);
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
