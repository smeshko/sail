import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildResult, writeResult } from '../../src/engine/result';
import { validateDocument } from '../../src/engine/schemas';
import type { StepRun } from '../../src/kinds/index';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RUN_ID = 'tests-01ARYZ6S410000000000000000';
const startedAt = new Date('2026-09-27T10:00:00.000Z');
const finishedAt = new Date('2026-09-27T10:00:02.500Z');
const record = { exit: { code: 0, mapped: 'passed' }, command: '.sail/stages/tests/run.sh', env: { RUN_ID } };
const passed: StepRun = { outcome: 'passed', output: { ok: true }, files: {}, errors: [], record };

const build = (run: StepRun) =>
  buildResult({ runId: RUN_ID, stage: 'tests', call: 1, kind: 'script', run, consumed: {}, startedAt, finishedAt });

test('a result carries the call, its outcome and timing, then the kind’s own fields, in that order', () => {
  const result = build(passed);
  expect(result).toEqual({
    schema: 'sail.result.v1',
    runId: RUN_ID,
    stage: 'tests',
    call: 1,
    key: 'tests#1',
    kind: 'script',
    outcome: 'passed',
    output: { ok: true },
    files: {},
    consumed: {},
    startedAt: '2026-09-27T10:00:00.000Z',
    finishedAt: '2026-09-27T10:00:02.500Z',
    durationMs: 2500,
    ...record,
  });
  expect(Object.keys(result)).toEqual([
    'schema',
    'runId',
    'stage',
    'call',
    'key',
    'kind',
    'outcome',
    'output',
    'files',
    'consumed',
    'startedAt',
    'finishedAt',
    'durationMs',
    'exit',
    'command',
    'env',
  ]);
  expect(validateDocument('sail.result.v1', result)).toEqual([]);
});

test('an error result lists its errors beside the outcome, and only an error result does', () => {
  const errors = [{ reason: 'missing_file' as const, message: "'junit.xml' was not produced in $STAGE_OUT" }];
  const result = build({ ...passed, outcome: 'error', output: null, errors });
  expect(result.errors).toEqual(errors);
  expect(Object.keys(result).slice(6, 9)).toEqual(['outcome', 'errors', 'output']);
  expect(validateDocument('sail.result.v1', result)).toEqual([]);
  expect('errors' in build({ ...passed, errors })).toBe(false);
});

test('writeResult writes 2-space JSON with a trailing newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sail-result-'));
  dirs.push(dir);
  const path = join(dir, 'result.json');
  const result = build(passed);
  writeResult(path, result);
  expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(result, null, 2)}\n`);
});

test('writeResult throws on a result that breaks the schema, and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sail-result-'));
  dirs.push(dir);
  const path = join(dir, 'result.json');
  const broken = { ...build(passed), outcome: 'error' };
  expect(() => writeResult(path, broken)).toThrow(
    'result.json breaks sail.result.v1, a bug in sail:\n[sail.result.v1]  /errors is required',
  );
  expect(existsSync(path)).toBe(false);
});

test("a built-in intake's result has no fields of a kind's own, and writeResult accepts it, passed or failed by its port", () => {
  const consumed = { source: 'run.json#/source' };
  const fields = { runId: RUN_ID, stage: 'intake', call: 1, kind: 'builtin', consumed, startedAt, finishedAt };
  const run: StepRun = { outcome: 'passed', output: { ticketKey: 'FAKE-1' }, files: {}, errors: [], record: {} };
  const result = buildResult({ ...fields, run });
  expect(validateDocument('sail.result.v1', result)).toEqual([]);
  expect(Object.keys(result)).toEqual([
    'schema',
    'runId',
    'stage',
    'call',
    'key',
    'kind',
    'outcome',
    'output',
    'files',
    'consumed',
    'startedAt',
    'finishedAt',
    'durationMs',
  ]);
  expect(result).toMatchObject({ key: 'intake#1', kind: 'builtin', outcome: 'passed', consumed });

  const errors = [{ reason: 'port' as const, message: 'ticketSource.get: no ticket FAKE-9 (not_found)' }];
  const failed = buildResult({ ...fields, run: { ...run, outcome: 'error', output: null, errors } });
  expect(validateDocument('sail.result.v1', failed)).toEqual([]);
  expect(failed.errors).toEqual(errors);

  const dir = mkdtempSync(join(tmpdir(), 'sail-result-'));
  dirs.push(dir);
  for (const [name, written] of Object.entries({ passed: result, failed })) {
    const path = join(dir, `${name}.json`);
    writeResult(path, written);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(written, null, 2)}\n`);
  }
});
