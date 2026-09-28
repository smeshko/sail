import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import {
  formatIssue,
  SCHEMA_NAMES,
  type SchemaName,
  validateDocument,
  validateProjectFile,
  validateRunDir,
} from '../../src/engine/schemas';
import type { NewEvent } from '../../src/events/types';

const root = join(import.meta.dir, '..', '..');
const RUN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const TS = '2026-09-25T09:00:00.000Z';
const fake = { use: 'fake', origin: 'builtin' };

const run = {
  schema: 'sail.run.v1',
  runId: RUN_ID,
  source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: false },
  workflow: { name: 'ticket-to-pr', version: 1 },
  sail: { version: '0.0.0', runtime: 'bun 1.3.14' },
  adapters: { ticketSource: fake, codeHost: fake, harness: fake, workspace: fake },
  intake: { name: 'ticket', kind: 'script', origin: 'builtin' },
  stages: { spec: { kind: 'agent', origin: 'repo:.sail/stages/spec' } },
  startedAt: TS,
};
const journal = {
  seq: 1,
  key: 'intake#1',
  stage: 'intake',
  call: 1,
  outcome: 'passed',
  output: {},
  reason: null,
  files: {},
  resultPath: '00-intake/call-1/result.json',
  recordedAt: TS,
};
/** The payload of the event type `T`. */
type Payload<T extends NewEvent['type']> = Omit<Extract<NewEvent, { type: T }>, 'type'>;
const envelope = { seq: 1, ts: TS, runId: RUN_ID };
const runStart: Payload<'run:start'> = {
  source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: false },
  workflow: {
    name: 'ticket-to-pr',
    version: 1,
    origin: 'repo:.sail/workflows/ticket-to-pr',
    sha256: 'e0b3cf9118c5580b04a63a226324576776169295075084965c306c90e250a710',
  },
  roster: {
    intake: { name: 'ticket', kind: 'script', origin: 'builtin' },
    stages: { spec: { kind: 'agent', origin: 'repo:.sail/stages/spec' } },
  },
  adapters: { ticketSource: fake, codeHost: fake, harness: fake, workspace: fake },
};
const event = { ...envelope, type: 'run:start', ...runStart };
const runEnd = { ...envelope, seq: 2, type: 'run:end', status: 'completed', result: 'done', replays: 1 };
/** An event of a family a later epic closes. */
const later = { ...envelope, type: 'workspace:leased' };
const summary = {
  schema: 'sail.summary.v1',
  runId: RUN_ID,
  workflow: 'ticket-to-pr@1',
  source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli' },
  status: 'running',
  startedAt: TS,
  calls: [],
  totals: {
    stageCalls: 0,
    steps: 0,
    toolCalls: 0,
    denials: 0,
    replays: 1,
    usage: { costUsd: 0 },
    budget: { maxUsd: 25, usedPct: 0 },
  },
  version: 1,
};
const call = {
  schema: 'sail.result.v1',
  runId: RUN_ID,
  output: {},
  files: {},
  consumed: {},
  startedAt: TS,
  finishedAt: TS,
  durationMs: 0,
};
const scriptResult = {
  ...call,
  stage: 'intake',
  call: 1,
  key: 'intake#1',
  kind: 'script',
  outcome: 'passed',
  exit: { code: 0 },
  command: 'builtin:ticket',
};
const agentResult = {
  ...call,
  stage: 'spec',
  call: 1,
  key: 'spec#1',
  kind: 'agent',
  outcome: 'done',
  harness: { adapter: 'fake', model: 'fake', provider: 'fake', sessionId: 's-1', turns: 1, toolCalls: 0, denials: 0 },
  usage: { costUsd: 0 },
};
const describeStep = {
  step: 'describe',
  kind: 'agent',
  outcome: 'done',
  resultPath: '05-publish/call-1/steps/1-describe/result.json',
};
const openStep = {
  step: 'open',
  kind: 'script',
  outcome: 'passed',
  resultPath: '05-publish/call-1/steps/2-open/result.json',
};
const multiStepResult = {
  ...call,
  stage: 'publish',
  call: 1,
  key: 'publish#1',
  outcome: 'passed',
  steps: [describeStep, openStep],
  usage: { costUsd: 0 },
};

function paths(schema: SchemaName, data: unknown): string[] {
  return validateDocument(schema, data).map((issue) => issue.path);
}

function omit(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _, ...rest } = data;
  return rest;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-schemas-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const json = (data: unknown): string => `${JSON.stringify(data, null, 2)}\n`;
const ndjson = (...lines: unknown[]): string => lines.map((line) => `${JSON.stringify(line)}\n`).join('');

const validRunDir = (): Record<string, string> => ({
  'run.json': json(run),
  'journal.ndjson': ndjson(journal),
  'events.ndjson': ndjson(event, runEnd),
  'summary.json': json(summary),
  '00-intake/call-1/result.json': json(scriptResult),
});

test.each([...SCHEMA_NAMES])('%s compiles in strict mode under its own $id', async (name) => {
  const schema = await Bun.file(join(root, 'schemas', `${name}.json`)).json();
  expect(schema.$id).toEndWith(`/schemas/${name}.json`);
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  expect(() => ajv.compile(schema)).not.toThrow();
});

test.each([
  ['sail.run.v1', run],
  ['sail.journal.v1', journal],
  ['sail.event.v1', event],
  ['sail.summary.v1', summary],
  ['sail.result.v1', scriptResult],
  ['sail.result.v1', agentResult],
  ['sail.result.v1', multiStepResult],
] as const)('a minimal %s document is valid', (schema, data) => {
  expect(validateDocument(schema, data)).toEqual([]);
});

test('run: an unknown key is not allowed and a missing source is required', () => {
  expect(validateDocument('sail.run.v1', { ...run, colour: 'blue' })).toEqual([
    { schema: 'sail.run.v1', path: '/colour', message: 'is not allowed' },
  ]);
  expect(validateDocument('sail.run.v1', omit(run, 'source'))).toEqual([
    { schema: 'sail.run.v1', path: '/source', message: 'is required' },
  ]);
});

test("event: the type is exhaustive, runId is required, and a later family's payload is open, key and all", () => {
  expect(paths('sail.event.v1', { ...later, type: 'agent:thought' })).toEqual(['/type']);
  expect(paths('sail.event.v1', omit(later, 'runId'))).toEqual(['/runId']);
  expect(paths('sail.event.v1', { ...later, remote: 'fake://codehost/fixture', anything: [1, 2] })).toEqual([]);
  expect(paths('sail.event.v1', { ...later, type: 'agent:message', key: 'spec#1', text: 'hi' })).toEqual([]);
});

const KEY = 'tests#1';

/** One sample of each type this phase closes, from its payload table (DECISIONS D5). */
const CLOSED: NewEvent[] = [
  { type: 'run:start', ...runStart, budget: { maxUsd: 25, maxMinutes: 90 } },
  { type: 'run:end', status: 'failed', stopReason: 'workflow_failed', message: 'loop "fix" exceeded 3', replays: 8 },
  { type: 'stage:start', key: KEY, stage: 'tests', call: 1, try: 2, kind: 'script', consumed: { exit: '--bind' } },
  {
    type: 'stage:end',
    key: KEY,
    stage: 'tests',
    call: 1,
    try: 2,
    outcome: 'error',
    durationMs: 1012,
    resultPath: '03-tests/call-1/try-2/result.json',
    errors: [{ reason: 'timeout', message: 'timed out after 1s' }],
  },
  {
    type: 'intake:start',
    key: 'intake#1',
    intake: 'ticket',
    kind: 'script',
    origin: 'builtin',
    consumed: { source: 'run.json#/source' },
  },
  { type: 'intake:end', key: 'intake#1', outcome: 'passed', resultPath: '00-intake/call-1/result.json' },
  {
    type: 'step:start',
    key: 'publish#1/open',
    stage: 'publish',
    step: 'open',
    index: 2,
    of: 2,
    kind: 'script',
    command: '.sail/workflows/ticket-to-pr/stages/publish/open.sh',
  },
  {
    type: 'step:end',
    key: 'publish#1/open',
    step: 'open',
    outcome: 'passed',
    resultPath: '05-publish/call-1/steps/2-open/result.json',
  },
  { type: 'input:materialised', key: KEY, binding: 'exit', from: '--bind' },
  {
    type: 'script:exec',
    key: KEY,
    command: '.sail/stages/tests/run.sh',
    cwd: '.',
    envKeys: ['RUN_ID', 'STAGE', 'CALL', 'TRY', 'STAGE_IN', 'STAGE_OUT', 'WORKSPACE', 'SAIL_CONFIG', 'INPUT_EXIT'],
  },
  { type: 'script:exit', key: KEY, code: null, signal: 'SIGTERM', durationMs: 1004, stdoutBytes: 0 },
  { type: 'output:validated', key: KEY },
  { type: 'output:invalid', key: KEY, message: "the output doesn't match its schema:\n✖ Invalid input" },
  {
    type: 'file:produced',
    key: KEY,
    name: 'junit.xml',
    path: '03-tests/call-1/junit.xml',
    bytes: 14,
    sha256: 'c98a97ba5504e953e5ddd12d9b65f5f176325398331606b16512f617d3a3358f',
  },
  { type: 'file:validated', key: 'spec#1', name: 'spec.md', ok: true, checks: ['noPlaceholders'] },
  { type: 'journal:append', key: KEY, line: 3, outcome: 'failed' },
  {
    type: 'loop:iteration',
    loop: 'fix',
    iteration: 2,
    max: 3,
    feedback: { from: '03-tests/call-1/result.json#/output' },
  },
  { type: 'loop:exit', loop: 'fix', iterations: 3, max: 3, reason: 'exceeded' },
  { type: 'workflow:route', at: 'tests#2', value: 'passed', took: 'self-review#1' },
  { type: 'error:timeout', key: KEY, message: 'timed out after 1s', timeoutSeconds: 1 },
  { type: 'error:crash', key: KEY, message: "journal.ndjson:3 can't be read" },
  {
    type: 'error:consumer',
    consumer: 'events.ndjson',
    failed: { seq: 7, type: 'stage:start' },
    message: 'ENOSPC: no space left on device, write',
  },
];

/** The closed types that belong to a call, and so require its key. */
const CALL_LEVEL = new Set([
  'stage:start',
  'stage:end',
  'intake:start',
  'intake:end',
  'step:start',
  'step:end',
  'input:materialised',
  'script:exec',
  'script:exit',
  'output:validated',
  'output:invalid',
  'file:produced',
  'file:validated',
  'journal:append',
  'error:timeout',
]);

const stamped = (sample: NewEvent): Record<string, unknown> => ({ ...envelope, ...sample });

test.each(CLOSED.map((sample) => [sample.type, sample] as const))(
  '%s accepts its payload, and rejects a field it does not declare',
  (_, sample) => {
    expect(validateDocument('sail.event.v1', stamped(sample))).toEqual([]);
    expect(validateDocument('sail.event.v1', { ...stamped(sample), surprise: 1 })).toEqual([
      { schema: 'sail.event.v1', path: '/surprise', message: 'is not allowed' },
    ]);
  },
);

test.each(CLOSED.filter((sample) => CALL_LEVEL.has(sample.type)).map((sample) => [sample.type, sample] as const))(
  '%s requires the key of its call',
  (_, sample) => {
    expect(CALL_LEVEL.size).toBe(15);
    expect(validateDocument('sail.event.v1', omit(stamped(sample), 'key'))).toEqual([
      { schema: 'sail.event.v1', path: '/key', message: 'is required' },
    ]);
  },
);

test('summary: a stop reason is required when failed or suspended, and forbidden otherwise', () => {
  expect(validateDocument('sail.summary.v1', { ...summary, status: 'failed' })).toEqual([
    { schema: 'sail.summary.v1', path: '/stopReason', message: 'is required' },
  ]);
  expect(paths('sail.summary.v1', { ...summary, status: 'suspended', stopReason: 'budget_exceeded' })).toEqual([]);
  expect(validateDocument('sail.summary.v1', { ...summary, status: 'completed', stopReason: 'stopped' })).toEqual([
    { schema: 'sail.summary.v1', path: '/stopReason', message: 'is not allowed' },
  ]);
});

test('summary: a suspended run may be stopped by an interrupt', () => {
  expect(validateDocument('sail.summary.v1', { ...summary, status: 'suspended', stopReason: 'interrupted' })).toEqual(
    [],
  );
});

test('result: dispatch reports only the branch the document claims to be', () => {
  expect(validateDocument('sail.result.v1', { ...scriptResult, outcome: 'done' })).toEqual([
    { schema: 'sail.result.v1', path: '/outcome', message: 'must be equal to one of the allowed values' },
  ]);
  expect(paths('sail.result.v1', { ...agentResult, outcome: 'passed' })).toEqual(['/outcome']);
  expect(paths('sail.result.v1', { ...multiStepResult, steps: [describeStep] })).toEqual(['/steps']);
});

const invalidOutput = { reason: 'invalid_output', message: 'the last stdout line is not JSON' };

test.each([
  ['script', scriptResult],
  ['agent', agentResult],
  ['multi-step', multiStepResult],
] as const)('result: a %s result lists its errors when the outcome is error, and only then', (_, result) => {
  const failing = {
    ...result,
    outcome: 'error',
    ...('steps' in result ? { steps: [describeStep, { ...openStep, outcome: 'error' }] } : {}),
  };
  expect(validateDocument('sail.result.v1', { ...failing, errors: [invalidOutput] })).toEqual([]);
  expect(validateDocument('sail.result.v1', failing)).toEqual([
    { schema: 'sail.result.v1', path: '/errors', message: 'is required' },
  ]);
  expect(validateDocument('sail.result.v1', { ...result, errors: [invalidOutput] })).toEqual([
    { schema: 'sail.result.v1', path: '/errors', message: 'is not allowed' },
  ]);
});

test('result: errors is non-empty, and each error has a known reason and a message', () => {
  const failing = { ...scriptResult, outcome: 'error' };
  expect(paths('sail.result.v1', { ...failing, errors: [] })).toEqual(['/errors']);
  expect(paths('sail.result.v1', { ...failing, errors: [{ ...invalidOutput, reason: 'oops' }] })).toEqual([
    '/errors/0/reason',
  ]);
  expect(paths('sail.result.v1', { ...failing, errors: [{ ...invalidOutput, message: '' }] })).toEqual([
    '/errors/0/message',
  ]);
  expect(paths('sail.result.v1', { ...failing, errors: [{ ...invalidOutput, hint: 'x' }] })).toEqual([
    '/errors/0/hint',
  ]);
  const reasons = [
    'invalid_output',
    'missing_file',
    'timeout',
    'exit_code',
    'not_started',
    'budget_exceeded',
    'harness',
  ];
  const every = reasons.map((reason) => ({ reason, message: reason }));
  expect(paths('sail.result.v1', { ...failing, errors: every })).toEqual([]);
});

test("result: a script's exit code is null only beside the signal that ended it, and exit is left out if it never started", () => {
  const killed = { ...scriptResult, outcome: 'error', errors: [{ reason: 'timeout', message: 'timed out after 1s' }] };
  expect(paths('sail.result.v1', { ...killed, exit: { code: null, signal: 'SIGTERM' } })).toEqual([]);
  expect(validateDocument('sail.result.v1', { ...killed, exit: { code: null } })).toEqual([
    { schema: 'sail.result.v1', path: '/exit/signal', message: 'is required' },
  ]);
  expect(paths('sail.result.v1', { ...killed, exit: { code: null, signal: 'TERM' } })).toEqual(['/exit/signal']);
  const notStarted = {
    ...omit(scriptResult, 'exit'),
    outcome: 'error',
    errors: [{ reason: 'not_started', message: 'ENOENT' }],
  };
  expect(paths('sail.result.v1', notStarted)).toEqual([]);
});

test("result: a multi-step call's outcome must be its last step's", () => {
  const blockedLast = { ...describeStep, step: 'finish', outcome: 'blocked' };
  expect(validateDocument('sail.result.v1', { ...multiStepResult, steps: [openStep, blockedLast] })).toEqual([
    { schema: 'sail.result.v1', path: '/outcome', message: "must equal the last step's outcome (blocked)" },
  ]);
  expect(
    validateDocument('sail.result.v1', { ...multiStepResult, outcome: 'blocked', steps: [openStep, blockedLast] }),
  ).toEqual([]);
});

test('journal: an unknown outcome names the field', () => {
  expect(paths('sail.journal.v1', { ...journal, outcome: 'maybe' })).toEqual(['/outcome']);
});

test('property names in a path are escaped as JSON pointer segments', () => {
  expect(paths('sail.run.v1', { ...run, 'a/b~c': 1 })).toEqual(['/a~1b~0c']);
});

test('validateRunDir counts every document and finds nothing wrong in a valid run directory', () => {
  expect(validateRunDir(tempDir(validRunDir()))).toEqual({
    counts: { 'sail.run.v1': 1, 'sail.journal.v1': 1, 'sail.event.v1': 2, 'sail.summary.v1': 1, 'sail.result.v1': 1 },
    issues: [],
  });
});

test('validateRunDir skips blank lines and absent optional files, and walks only call directories', () => {
  const dir = tempDir({
    'run.json': json(run),
    'events.ndjson': `\n${ndjson(event)}\n`,
    'workspace/test/fixtures/result.json': '{ "not": "a result" }',
  });
  expect(validateRunDir(dir)).toEqual({ counts: { 'sail.run.v1': 1, 'sail.event.v1': 1 }, issues: [] });
});

test('validateRunDir reports an events file whose seq skips a number', () => {
  const gap = { ...validRunDir(), 'events.ndjson': ndjson(event, { ...runEnd, seq: 3 }) };
  expect(validateRunDir(tempDir(gap)).issues.map(formatIssue)).toEqual([
    'events.ndjson:2  [sail.event.v1]  /seq must be 2, its place in the events file',
  ]);
});

test('validateRunDir reports a missing run.json', () => {
  const files = validRunDir();
  delete files['run.json'];
  expect(validateRunDir(tempDir(files)).issues).toEqual([
    { file: 'run.json', schema: 'sail.run.v1', path: '/', message: 'is missing' },
  ]);
});

test('validateRunDir reports an unparseable line or file by file and line', () => {
  const dir = tempDir({
    ...validRunDir(),
    'events.ndjson': `${JSON.stringify(event)}\n{ not json\n`,
    'summary.json': '{',
  });
  const issues = validateRunDir(dir).issues.map(formatIssue);
  expect(issues).toHaveLength(2);
  expect(issues[0]).toStartWith('events.ndjson:2  [sail.event.v1]  / is not valid JSON: ');
  expect(issues[1]).toStartWith('summary.json  [sail.summary.v1]  / is not valid JSON: ');
});

test('validateRunDir reports a nested result.json by its path in the run directory', () => {
  const dir = tempDir({
    ...validRunDir(),
    '01-spec/call-1/result.json': json({ ...scriptResult, stage: 'spec', key: 'spec#1', outcome: 'approved' }),
    '05-publish/call-1/steps/2-open/result.json': json({ ...scriptResult, extra: true }),
  });
  const { counts, issues } = validateRunDir(dir);
  expect(counts['sail.result.v1']).toBe(3);
  expect(issues.map(formatIssue)).toEqual([
    '01-spec/call-1/result.json  [sail.result.v1]  /outcome must be equal to one of the allowed values',
    '05-publish/call-1/steps/2-open/result.json  [sail.result.v1]  /extra is not allowed',
  ]);
});

const publishFiles = (): Record<string, string> => ({
  '05-publish/call-1/result.json': json(multiStepResult),
  '05-publish/call-1/steps/1-describe/result.json': json({
    ...agentResult,
    stage: 'publish',
    step: 'describe',
    key: 'publish#1/describe',
  }),
  '05-publish/call-1/steps/2-open/result.json': json({
    ...scriptResult,
    stage: 'publish',
    step: 'open',
    key: 'publish#1/open',
  }),
});

test('validateRunDir checks that a multi-step call points at results for its own steps', () => {
  expect(validateRunDir(tempDir({ ...validRunDir(), ...publishFiles() })).issues).toEqual([]);
  const wrongLink = {
    ...multiStepResult,
    steps: [describeStep, { ...openStep, resultPath: '00-intake/call-1/result.json' }],
  };
  const dir = tempDir({ ...validRunDir(), ...publishFiles(), '05-publish/call-1/result.json': json(wrongLink) });
  expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([
    '05-publish/call-1/result.json  [sail.result.v1]  /steps/1/resultPath points at 00-intake/call-1/result.json, ' +
      'which differs in key ("intake#1", not "publish#1/open"), stage ("intake", not "publish"), step (undefined, not "open")',
  ]);
});

test('validateRunDir checks that every journal line points at a result that agrees with it', () => {
  const missing = tempDir({
    ...validRunDir(),
    'journal.ndjson': ndjson({ ...journal, resultPath: '01-spec/call-1/result.json' }),
  });
  const disagrees = tempDir({
    ...validRunDir(),
    'journal.ndjson': ndjson({ ...journal, outcome: 'failed' }),
    '00-intake/call-1/result.json': json({ ...scriptResult, runId: 'FAKE-2-01M3BWNZM08Q4T6V2XRJ5KWD3N' }),
  });
  expect([...validateRunDir(missing).issues, ...validateRunDir(disagrees).issues].map(formatIssue)).toEqual([
    'journal.ndjson:1  [sail.journal.v1]  /resultPath points at no result.json: 01-spec/call-1/result.json',
    'journal.ndjson:1  [sail.journal.v1]  /resultPath points at 00-intake/call-1/result.json, ' +
      'which differs in runId ("FAKE-2-01M3BWNZM08Q4T6V2XRJ5KWD3N", not "FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N"), ' +
      'outcome ("passed", not "failed")',
  ]);
});

test('validateRunDir checks that a journal line replays the output and files its result recorded', () => {
  const brief = { path: '00-intake/call-1/brief.md', bytes: 1, sha256: 'a'.repeat(64) };
  const dir = tempDir({
    ...validRunDir(),
    'journal.ndjson': ndjson({ ...journal, output: { ticketKey: 'FAKE-1' }, files: { 'brief.md': brief.path } }),
    '00-intake/call-1/result.json': json({
      ...scriptResult,
      output: { ticketKey: 'FAKE-2' },
      files: { 'brief.md': brief },
    }),
  });
  expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([
    'journal.ndjson:1  [sail.journal.v1]  /resultPath points at 00-intake/call-1/result.json, which differs in output',
  ]);
  const moved = tempDir({
    ...validRunDir(),
    'journal.ndjson': ndjson({ ...journal, files: { 'brief.md': 'elsewhere/brief.md' } }),
    '00-intake/call-1/result.json': json({ ...scriptResult, files: { 'brief.md': brief } }),
  });
  expect(validateRunDir(moved).issues.map(formatIssue)).toEqual([
    'journal.ndjson:1  [sail.journal.v1]  /resultPath points at 00-intake/call-1/result.json, which differs in files',
  ]);
});

test('validateRunDir requires a completed run to journal every result, in order', () => {
  const unjournaled = { ...validRunDir(), '01-spec/call-1/result.json': json(agentResult) };
  expect(validateRunDir(tempDir(unjournaled)).issues).toEqual([]);
  const completed = { ...unjournaled, 'summary.json': json({ ...summary, status: 'completed' }) };
  expect(validateRunDir(tempDir(completed)).issues.map(formatIssue)).toEqual([
    '01-spec/call-1/result.json  [sail.result.v1]  / is not journaled, and the run completed',
  ]);
  const noJournal: Record<string, string> = { ...completed };
  delete noJournal['journal.ndjson'];
  expect(validateRunDir(tempDir(noJournal)).issues.map(formatIssue)).toEqual([
    'journal.ndjson  [sail.journal.v1]  / is missing or empty, and the run completed',
  ]);
  const outOfOrder = { ...validRunDir(), 'journal.ndjson': ndjson({ ...journal, seq: 2 }) };
  expect(validateRunDir(tempDir(outOfOrder)).issues.map(formatIssue)).toEqual([
    'journal.ndjson:1  [sail.journal.v1]  /seq must be 1, its place in the journal',
  ]);
});

test("validateRunDir takes a completed run's unjournaled try as superseded by its call's journaled later try", () => {
  const spec = (n: number) => json({ ...agentResult, call: n, key: `spec#${n}` });
  const retried = {
    ...validRunDir(),
    'summary.json': json({ ...summary, status: 'completed' }),
    'journal.ndjson': ndjson(journal, {
      ...journal,
      seq: 2,
      key: 'spec#1',
      stage: 'spec',
      outcome: 'done',
      resultPath: '01-spec/call-1/try-2/result.json',
    }),
    '01-spec/call-1/result.json': spec(1),
    '01-spec/call-1/try-2/result.json': spec(1),
  };
  expect(validateRunDir(tempDir(retried)).issues.map(formatIssue)).toEqual([]);
  const anotherCall = { ...retried, '01-spec/call-2/result.json': spec(2) };
  expect(validateRunDir(tempDir(anotherCall)).issues.map(formatIssue)).toEqual([
    '01-spec/call-2/result.json  [sail.result.v1]  / is not journaled, and the run completed',
  ]);
});

test('validateRunDir reports an invalid linked result once, by its own issues', () => {
  const dir = tempDir({ ...validRunDir(), '00-intake/call-1/result.json': json({ ...scriptResult, extra: true }) });
  expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([
    '00-intake/call-1/result.json  [sail.result.v1]  /extra is not allowed',
  ]);
});

test('formatIssue gives the line and leaves out what an issue does not carry', () => {
  expect(
    formatIssue({ file: 'journal.ndjson', line: 7, schema: 'sail.journal.v1', path: '/outcome', message: 'x' }),
  ).toBe('journal.ndjson:7  [sail.journal.v1]  /outcome x');
  expect(formatIssue({ path: '/', message: 'is required' })).toBe('/ is required');
});

test('importing the module compiles nothing, and each schema compiles once', () => {
  const script = `
    import Ajv2020 from 'ajv/dist/2020';
    let compiled = 0;
    const compile = Ajv2020.prototype.compile;
    Ajv2020.prototype.compile = function (...args) { compiled++; return compile.apply(this, args); };
    const schemas = await import(${JSON.stringify(join(root, 'src', 'engine', 'schemas.ts'))});
    const onImport = compiled;
    schemas.validateDocument('sail.event.v1', {});
    schemas.validateDocument('sail.event.v1', {});
    console.log(JSON.stringify({ onImport, afterTwoCalls: compiled }));
  `;
  const result = Bun.spawnSync([process.execPath, '-e', script], { cwd: root });
  expect(result.stderr.toString()).toBe('');
  expect(JSON.parse(result.stdout.toString())).toEqual({ onImport: 0, afterTwoCalls: 1 });
});

const fixtureProject = join(root, 'test', 'fixtures', 'repo', '.sail', 'project.yaml');

function projectIssues(text: string): string[] {
  const issues = validateProjectFile(join(tempDir({ 'project.yaml': text }), 'project.yaml'));
  for (const issue of issues) console.log(`project.yaml  ${formatIssue(issue)}`);
  return issues.map((issue) => issue.path);
}

test('the fixture project.yaml is valid', () => {
  expect(validateProjectFile(fixtureProject)).toEqual([]);
});

test('project.yaml: an unknown key, a missing name and a missing adapter each name their path', async () => {
  const text = await Bun.file(fixtureProject).text();
  expect(projectIssues(`${text}colour: blue\n`)).toEqual(['/colour']);
  expect(projectIssues(text.replace('name: fixture\n', ''))).toEqual(['/name']);
  expect(projectIssues(text.replace('  harness: { use: fake }\n', ''))).toEqual(['/adapters/harness']);
  expect(projectIssues(text.replace('harness: { use: fake }', 'harness: { model: deep }'))).toEqual([
    '/adapters/harness/use',
  ]);
});

test('project.yaml: adapter options are open, and every other object is closed', async () => {
  const text = await Bun.file(fixtureProject).text();
  expect(
    projectIssues(text.replace('ticketSource: { use: fake }', 'ticketSource: { use: linear, team: ADW }')),
  ).toEqual([]);
  expect(projectIssues(text.replace('maxMinutes: 90', 'maxMinutes: 90, maxTurns: 5'))).toEqual([
    '/budgets/run/maxTurns',
  ]);
  expect(projectIssues(text.replace('deep: claude-opus-5-5', 'Deep: claude-opus-5-5'))).toEqual(['/models/Deep']);
  expect(projectIssues(text.replace('name: fixture', 'name: Fixture'))).toEqual(['/name']);
});

test('project.yaml: invalid YAML or an unreadable file is one issue, not a throw', () => {
  expect(projectIssues('name: [unclosed\n')).toEqual(['/']);
  const [issue] = validateProjectFile(join(tempDir({}), 'missing.yaml'));
  expect(issue).toMatchObject({ schema: 'sail.project.v1', path: '/' });
  expect(issue?.message).toContain('ENOENT');
});
