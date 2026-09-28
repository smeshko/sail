// The script step's contract end to end: runCall() in a temporary repository, each result.json read back from disk.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Supplied } from '../../src/engine/bindings';
import { type CallRequest, callProblems, runCall } from '../../src/engine/call';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import { agent, type StageDefinition, script, stage, value, z } from '../../src/sdk/index';
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
