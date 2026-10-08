import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] },
  claim: { claimed: true, state: { type: 'started', name: 'In Progress' } },
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
  source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] },
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
const later = { ...envelope, type: 'run:adopted' };
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
  ['sail.journal.v1', journal],
  ['sail.summary.v1', summary],
  ['sail.result.v1', scriptResult],
  ['sail.result.v1', agentResult],
  ['sail.result.v1', multiStepResult],
] as const)('a minimal %s document is valid', (schema, data) => {
  expect(validateDocument(schema, data)).toEqual([]);
});

// The two that carry the run's source, and with it the checks `--force` overrode.
test.each([
  ['sail.run.v1', run],
  ['sail.event.v1', event],
] as const)('a minimal %s document is valid, its source included', (schema, data) => {
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

/** The closed samples whose type `is` says, each with its type as the case's name. */
const closed = (is: (type: NewEvent['type']) => boolean) =>
  CLOSED.filter((sample) => is(sample.type)).map((sample) => [sample.type, sample] as const);

function acceptsOnlyItsPayload(_: string, sample: NewEvent): void {
  expect(validateDocument('sail.event.v1', stamped(sample))).toEqual([]);
  expect(validateDocument('sail.event.v1', { ...stamped(sample), surprise: 1 })).toEqual([
    { schema: 'sail.event.v1', path: '/surprise', message: 'is not allowed' },
  ]);
}

test.each(closed((type) => type !== 'run:start'))(
  '%s accepts its payload, and rejects a field it does not declare',
  acceptsOnlyItsPayload,
);

// run:start on its own: its payload is the run header's, the source and what `--force` overrode included.
test.each(closed((type) => type === 'run:start'))(
  "%s accepts its payload, the run header's own, and rejects a field it does not declare",
  acceptsOnlyItsPayload,
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

const SPEC = 'spec#1';
const specUsage = {
  inputTokens: 5200,
  cacheReadTokens: 18400,
  cacheWriteTokens: 3100,
  outputTokens: 1450,
  costUsd: 0.3125,
};
const sessionEnd = {
  type: 'harness:session_end',
  key: SPEC,
  sessionId: 'fake-session-spec-1',
  outcome: 'done',
  reason: 'submitted',
  turns: 4,
  toolCalls: 2,
  denials: 0,
  usage: specUsage,
} as const;
const usageUpdate = {
  type: 'usage:update',
  key: SPEC,
  turn: 4,
  tokens: { input: 5200, cacheRead: 18400, cacheWrite: 3100, output: 1450 },
  costUsdSoFar: 0.3125,
} as const;
const fragments = [
  { name: 'untrusted-input', origin: 'builtin' },
  { name: 'finish', origin: 'repo:.sail/prompts/_shared/finish.md' },
];

/** One sample of each type the agent step closes, from the golden run where it has one. */
const AGENT: NewEvent[] = [
  {
    type: 'prompt:rendered',
    key: SPEC,
    try: 2,
    path: '01-spec/call-1/try-2/prompt.md',
    untrusted: 2,
    fragments,
    conventions: ['AGENTS.md', 'CLAUDE.md'],
  },
  {
    type: 'harness:session_start',
    key: SPEC,
    adapter: 'fake',
    sessionId: 'fake-session-spec-1',
    model: 'claude-opus-5-5',
  },
  sessionEnd,
  { type: 'agent:message', key: SPEC, text: 'Spec written: two tasks, greet() and the CLI first, then the tests.' },
  { type: 'agent:thinking', key: SPEC, text: 'The brief asks for one flag.' },
  { type: 'tool:start', key: SPEC, callId: 'tool-1', tool: 'Read', input: { path: 'src/greet.ts' } },
  { type: 'tool:end', key: SPEC, callId: 'tool-1', status: 'completed', durationMs: 40 },
  {
    type: 'permission:denied',
    key: 'implement#1',
    callId: 'tool-3',
    tool: 'Bash',
    rule: 'commands',
    permissions: { commands: ['bun test*', 'git add *', 'git commit *', 'git diff *'] },
    reason: "'git push origin HEAD' matches none of the step's commands",
  },
  usageUpdate,
  { type: 'budget:warning', key: SPEC, budget: 'usd', limit: 2, used: 1.6 },
  { type: 'budget:exceeded', key: SPEC, budget: 'turns', limit: 40, used: 40 },
  { type: 'error:harness', key: SPEC, message: 'model overloaded' },
];

test.each(AGENT.map((sample) => [sample.type, sample] as const))(
  '%s accepts its agent payload, and rejects a field it does not declare',
  (_, sample) => {
    expect(validateDocument('sail.event.v1', stamped(sample))).toEqual([]);
    expect(validateDocument('sail.event.v1', { ...stamped(sample), surprise: 1 })).toEqual([
      { schema: 'sail.event.v1', path: '/surprise', message: 'is not allowed' },
    ]);
  },
);

test.each(AGENT.filter((sample) => !sample.type.startsWith('budget:')).map((sample) => [sample.type, sample] as const))(
  '%s requires the key of its call, which a harness leaves to the agent step',
  (_, sample) => {
    expect(validateDocument('sail.event.v1', omit(stamped(sample), 'key'))).toEqual([
      { schema: 'sail.event.v1', path: '/key', message: 'is required' },
    ]);
  },
);

test('agent events: a session end is complete, usage is never negative, and a budget event may belong to the run', () => {
  const check = (sample: Record<string, unknown>) => paths('sail.event.v1', { ...envelope, ...sample }).sort();
  // The fake's end before this phase: an outcome and nothing else.
  expect(check({ type: 'harness:session_end', key: SPEC, outcome: 'done' })).toEqual([
    '/denials',
    '/toolCalls',
    '/turns',
    '/usage',
  ]);
  // The golden run's end before this phase: everything but the outcome.
  expect(check(omit(sessionEnd, 'outcome'))).toEqual(['/outcome']);
  expect(check(omit(omit(sessionEnd, 'sessionId'), 'reason'))).toEqual([]);
  expect(check({ ...sessionEnd, outcome: 'passed' })).toEqual(['/outcome']);
  expect(check({ ...sessionEnd, turns: -1 })).toEqual(['/turns']);
  expect(check({ ...sessionEnd, usage: { ...specUsage, costUsd: -0.01 } })).toEqual(['/usage/costUsd']);
  expect(check({ ...sessionEnd, usage: { ...specUsage, outputTokens: 1.5 } })).toEqual(['/usage/outputTokens']);
  expect(check({ ...usageUpdate, costUsdSoFar: -0.01 })).toEqual(['/costUsdSoFar']);
  expect(check({ ...usageUpdate, tokens: { ...usageUpdate.tokens, input: -1 } })).toEqual(['/tokens/input']);
  expect(check({ type: 'tool:end', key: SPEC, callId: 'tool-1', status: 'ok', durationMs: 40 })).toEqual(['/status']);
  expect(check({ type: 'budget:exceeded', budget: 'usd', limit: 25, used: 25.5 })).toEqual([]);
  expect(check({ type: 'budget:exceeded', key: SPEC, budget: 'tokens', limit: 1, used: 1 })).toEqual(['/budget']);
});

const SHA = 'b4efb0c5de84d87c1455d4504b8b75b095a8e10b';
const OPEN = 'publish#1/open';
const lease = { remote: 'fake://codehost/fixture', branch: 'sail/FAKE-1' };
const WORKSPACE = '.sail-runs/FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N/workspace';

/** One sample of each provider type, from the golden run where it has one (ports-and-fakes D10). */
const PROVIDER: NewEvent[] = [
  {
    type: 'ticket:fetched',
    key: 'intake#1',
    ticketKey: 'FAKE-1',
    comments: 1,
    links: 0,
    attachments: 0,
    durationMs: 310,
  },
  { type: 'ticket:claimed', ticketKey: 'FAKE-1', state: { type: 'started', name: 'In Progress' } },
  {
    type: 'ticket:updated',
    key: OPEN,
    ticketKey: 'FAKE-1',
    change: { state: 'in-review' },
    state: { type: 'started', name: 'In Review' },
  },
  {
    type: 'ticket:commented',
    key: OPEN,
    ticketKey: 'FAKE-1',
    body: 'Pull request opened: fake://codehost/fixture/pull/1',
  },
  { type: 'codehost:pushed', key: OPEN, branch: 'sail/FAKE-1', headSha: SHA },
  {
    type: 'codehost:pr_opened',
    key: OPEN,
    number: 1,
    url: 'fake://codehost/fixture/pull/1',
    draft: false,
    base: 'main',
    head: 'sail/FAKE-1',
    ticketKey: 'FAKE-1',
  },
  { type: 'codehost:checks', number: 1, headSha: SHA, checks: [{ name: 'ci', status: 'passed' }] },
  { type: 'codehost:labelled', key: OPEN, number: 1, label: 'sail', change: 'added' },
  { type: 'codehost:commented', number: 1, body: 'Checks passed.' },
  { type: 'codehost:merged', number: 1, method: 'squash', sha: 'f569e7f50659194ebd39f2f141e95091f40791da' },
  { type: 'workspace:leased', ...lease, took: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3M' },
  { type: 'workspace:lease_released', ...lease },
  {
    type: 'workspace:created',
    path: WORKSPACE,
    branch: 'sail/FAKE-1',
    baseSha: 'f569e7f50659194ebd39f2f141e95091f40791da',
    durationMs: 640,
  },
  { type: 'workspace:released', path: WORKSPACE, kept: false },
];

test.each(PROVIDER.map((sample) => [sample.type, sample] as const))(
  '%s accepts its provider payload, and rejects a field it does not declare',
  (_, sample) => {
    expect(validateDocument('sail.event.v1', stamped(sample))).toEqual([]);
    expect(validateDocument('sail.event.v1', { ...stamped(sample), surprise: 1 })).toEqual([
      { schema: 'sail.event.v1', path: '/surprise', message: 'is not allowed' },
    ]);
  },
);

test('provider events: a key where D10 allows one, and the rules each payload adds', () => {
  const issue = (path: string, message: string) => [{ schema: 'sail.event.v1' as const, path, message }];
  const check = (sample: Record<string, unknown>) => validateDocument('sail.event.v1', { ...envelope, ...sample });
  expect(check({ type: 'workspace:leased', ...lease, key: OPEN })).toEqual(issue('/key', 'is not allowed'));
  expect(check({ type: 'ticket:claimed', ticketKey: 'FAKE-1' })).toEqual(issue('/state', 'is required'));
  expect(check({ type: 'codehost:labelled', number: 1, label: 'sail', change: 'swapped' })).toEqual(
    issue('/change', 'must be equal to one of the allowed values'),
  );
  expect(check({ type: 'codehost:merged', number: 1, method: 'squash', sha: 'f569e7f' })).toEqual(
    issue('/sha', 'must match pattern "^[0-9a-f]{40}$"'),
  );
  expect(check({ type: 'codehost:merged', key: OPEN, number: 1, method: 'squash', sha: SHA })).toEqual([]);
});

test('event: a stop reason, errors and a signal each appear exactly when D5 says', () => {
  const issue = (path: string, message: string) => [{ schema: 'sail.event.v1' as const, path, message }];
  const check = (sample: NewEvent) => validateDocument('sail.event.v1', stamped(sample));
  const end = { type: 'run:end', replays: 1 } as const;
  expect(check({ ...end, status: 'completed', stopReason: 'stopped' })).toEqual(issue('/stopReason', 'is not allowed'));
  expect(check({ ...end, status: 'failed' })).toEqual(issue('/stopReason', 'is required'));
  expect(check({ ...end, status: 'suspended' })).toEqual(issue('/stopReason', 'is required'));
  expect(check({ ...end, status: 'suspended', stopReason: 'interrupted', message: 'stopped during tests#1' })).toEqual(
    [],
  );

  const stageEnd = {
    type: 'stage:end',
    key: KEY,
    stage: 'tests',
    call: 1,
    try: 1,
    durationMs: 12,
    resultPath: '03-tests/call-1/result.json',
  } as const;
  const errors = [{ reason: 'timeout', message: 'timed out after 1s' }] as const;
  expect(check({ ...stageEnd, outcome: 'error' })).toEqual(issue('/errors', 'is required'));
  expect(check({ ...stageEnd, outcome: 'passed', errors: [...errors] })).toEqual(issue('/errors', 'is not allowed'));
  expect(check({ ...stageEnd, outcome: 'failed' })).toEqual([]);

  const exit = { type: 'script:exit', key: KEY, durationMs: 5, stdoutBytes: 0 } as const;
  expect(check({ ...exit, code: null })).toEqual(issue('/signal', 'is required'));
  expect(check({ ...exit, code: 1, outcome: 'failed' })).toEqual([]);
});

test('summary: a stop reason is required when failed or suspended, and forbidden otherwise', () => {
  expect(validateDocument('sail.summary.v1', { ...summary, status: 'failed' })).toEqual([
    { schema: 'sail.summary.v1', path: '/stopReason', message: 'is required' },
  ]);
  expect(paths('sail.summary.v1', { ...summary, status: 'suspended', stopReason: 'budget_exceeded' })).toEqual([]);
  expect(validateDocument('sail.summary.v1', { ...summary, status: 'completed', stopReason: 'stopped' })).toEqual([
    { schema: 'sail.summary.v1', path: '/stopReason', message: 'is not allowed' },
  ]);
});

test('summary: totals may leave out budget, as for a run with no budget.maxUsd', () => {
  const { budget: _, ...totals } = summary.totals;
  expect(validateDocument('sail.summary.v1', { ...summary, totals })).toEqual([]);
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

test('result: an agent result records its try, its place in validation and its prompt, and only the session facts it has', () => {
  const prompt = { path: '01-spec/call-1/try-3/prompt.md', untrusted: 2, fragments, conventions: ['AGENTS.md'] };
  const recorded = { ...agentResult, try: 3, validationTry: 2, validationFailed: false, prompt };
  expect(paths('sail.result.v1', recorded)).toEqual([]);
  // A try that never reached a session has no session id, and no adapter names its provider yet.
  const { provider: _provider, sessionId: _sessionId, ...neverStarted } = agentResult.harness;
  expect(paths('sail.result.v1', { ...recorded, harness: neverStarted })).toEqual([]);
  expect(paths('sail.result.v1', { ...recorded, try: 0 })).toEqual(['/try']);
  expect(paths('sail.result.v1', { ...recorded, validationTry: 3 })).toEqual(['/validationTry']);
  expect(paths('sail.result.v1', { ...recorded, validationFailed: 'yes' })).toEqual(['/validationFailed']);
  expect(paths('sail.result.v1', { ...recorded, prompt: { ...prompt, text: 'Read the brief.' } })).toEqual([
    '/prompt/text',
  ]);
  expect(paths('sail.result.v1', { ...recorded, prompt: omit(prompt, 'conventions') })).toEqual([
    '/prompt/conventions',
  ]);
  expect(paths('sail.result.v1', { ...recorded, harness: { ...neverStarted, raw: {} } })).toEqual(['/harness/raw']);
  expect(paths('sail.result.v1', { ...recorded, usage: { costUsd: -0.01 } })).toEqual(['/usage/costUsd']);
});

test('result: a blocked agent result gives its reason, and whitespace is not one', () => {
  const blocked = { ...agentResult, outcome: 'blocked', output: null };
  expect(validateDocument('sail.result.v1', blocked)).toEqual([
    { schema: 'sail.result.v1', path: '/reason', message: 'is required' },
  ]);
  expect(paths('sail.result.v1', { ...blocked, reason: '' })).toEqual(['/reason']);
  expect(paths('sail.result.v1', { ...blocked, reason: ' \n\t' })).toEqual(['/reason']);
  expect(paths('sail.result.v1', { ...blocked, reason: 'The brief has no acceptance criteria.' })).toEqual([]);
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

test('project.yaml: conventions is a list of distinct file paths, and may be empty', async () => {
  const text = await Bun.file(fixtureProject).text();
  expect(projectIssues(`${text}conventions: [AGENTS.md, docs/STYLE.md]\n`)).toEqual([]);
  expect(projectIssues(`${text}conventions: []\n`)).toEqual([]);
  expect(projectIssues(`${text}conventions: AGENTS.md\n`)).toEqual(['/conventions']);
  expect(projectIssues(`${text}conventions: [AGENTS.md, AGENTS.md]\n`)).toEqual(['/conventions']);
  expect(projectIssues(`${text}conventions: [AGENTS.md, ""]\n`)).toEqual(['/conventions/1']);
  expect(projectIssues(`${text}conventions: [AGENTS.md, 7]\n`)).toEqual(['/conventions/1']);
});

// A built-in intake's call (D1): the kind `builtin`, and the error reason `port` (D7).

const builtinResult = {
  ...call,
  stage: 'intake',
  call: 1,
  key: 'intake#1',
  kind: 'builtin',
  outcome: 'passed',
  consumed: { source: 'run.json#/source' },
};
const portError = { reason: 'port', message: 'ticketSource.get: no ticket FAKE-9 (not_found)' };

test("result: a built-in intake's result has exactly its thirteen fields, and errors exactly when it ended in error", () => {
  expect(validateDocument('sail.result.v1', builtinResult)).toEqual([]);
  expect(Object.keys(builtinResult).sort()).toEqual([
    'call',
    'consumed',
    'durationMs',
    'files',
    'finishedAt',
    'key',
    'kind',
    'outcome',
    'output',
    'runId',
    'schema',
    'stage',
    'startedAt',
  ]);
  // Without its kind a result is read as an agent's, so every other field is left out in turn.
  for (const field of Object.keys(builtinResult).filter((name) => name !== 'kind')) {
    expect(validateDocument('sail.result.v1', omit(builtinResult, field))).toEqual([
      { schema: 'sail.result.v1', path: `/${field}`, message: 'is required' },
    ]);
  }
  const failing = { ...builtinResult, outcome: 'error', output: null };
  expect(validateDocument('sail.result.v1', failing)).toEqual([
    { schema: 'sail.result.v1', path: '/errors', message: 'is required' },
  ]);
  expect(validateDocument('sail.result.v1', { ...failing, errors: [portError] })).toEqual([]);
  expect(validateDocument('sail.result.v1', { ...builtinResult, errors: [portError] })).toEqual([
    { schema: 'sail.result.v1', path: '/errors', message: 'is not allowed' },
  ]);
});

test.each<[string, Record<string, unknown>, string]>([
  ['an exit', { exit: { code: 0 } }, '/exit'],
  ['a command', { command: 'builtin:ticket' }, '/command'],
  ['an env', { env: { RUN_ID } }, '/env'],
  ['a harness', { harness: agentResult.harness }, '/harness'],
  ['a usage', { usage: { costUsd: 0 } }, '/usage'],
  ['a prompt', { prompt: { path: 'prompt.md', untrusted: 0, fragments: [], conventions: [] } }, '/prompt'],
  ['a step', { step: 'fetch' }, '/step'],
  ['steps', { steps: [describeStep, openStep] }, '/steps'],
  ['the outcome failed', { outcome: 'failed' }, '/outcome'],
  ['the outcome done', { outcome: 'done' }, '/outcome'],
  ['the outcome blocked', { outcome: 'blocked' }, '/outcome'],
])("result: a built-in intake's result with %s is refused, naming it", (_, fields, path) => {
  expect(paths('sail.result.v1', { ...builtinResult, ...fields })).toEqual([path]);
});

test.each([
  ['built-in intake', builtinResult],
  ['script', scriptResult],
  ['agent', agentResult],
] as const)('result: a %s result may end in error with the reason port', (_, result) => {
  expect(validateDocument('sail.result.v1', { ...result, outcome: 'error', errors: [portError] })).toEqual([]);
});

test('event: intake:start takes the kind builtin, and neither a stage nor a step starts as one', () => {
  const intakeStart = {
    ...envelope,
    type: 'intake:start',
    key: 'intake#1',
    intake: 'ticket',
    kind: 'builtin',
    origin: 'builtin',
    consumed: { source: 'run.json#/source' },
  };
  expect(validateDocument('sail.event.v1', intakeStart)).toEqual([]);
  const stageStart = { ...envelope, type: 'stage:start', key: KEY, stage: 'tests', call: 1, try: 1, consumed: {} };
  expect(paths('sail.event.v1', { ...stageStart, kind: 'script' })).toEqual([]);
  expect(paths('sail.event.v1', { ...stageStart, kind: 'builtin' })).toEqual(['/kind']);
  const stepStart = { ...envelope, type: 'step:start', key: OPEN, stage: 'publish', step: 'open', index: 2, of: 2 };
  expect(paths('sail.event.v1', { ...stepStart, kind: 'script' })).toEqual([]);
  expect(paths('sail.event.v1', { ...stepStart, kind: 'builtin' })).toEqual(['/kind']);
});

test('event: stage:end takes the reason port in its errors, and every other reason a result may give', () => {
  const stageEnd = {
    ...envelope,
    type: 'stage:end',
    key: KEY,
    stage: 'tests',
    call: 1,
    try: 1,
    outcome: 'error',
    durationMs: 12,
    resultPath: '03-tests/call-1/result.json',
  };
  expect(validateDocument('sail.event.v1', { ...stageEnd, errors: [portError] })).toEqual([]);
  // A call's `stage:end` carries its result's errors as they are, so the two schemas list the same reasons.
  const reasonsOf = (file: string): string[] =>
    JSON.parse(readFileSync(join(root, 'schemas', file), 'utf8')).$defs.errors.items.properties.reason.enum;
  expect(reasonsOf('sail.event.v1.json')).toEqual(reasonsOf('sail.result.v1.json'));
});

// The run header's source and claim (D2, D9): `forced` lists the checks `--force` overrode, and `claim` says what the
// run's start did to its ticket.

const forcedIssues = (schema: SchemaName, document: { source: object }, forced: unknown): string[] =>
  paths(schema, { ...document, source: { ...document.source, forced } });

test('run: source.forced takes no check, either check, or both in order', () => {
  const taken = [[], ['designation'], ['state'], ['designation', 'state']];
  expect(taken.map((forced) => forcedIssues('sail.run.v1', run, forced))).toEqual([[], [], [], []]);
});

test('run: source.forced refuses a boolean, a check it does not know and a check listed twice, naming /source/forced', () => {
  const refused = [false, true, ['label'], ['state', 'state']];
  expect(refused.map((forced) => forcedIssues('sail.run.v1', run, forced))).toEqual([
    ['/source/forced'],
    ['/source/forced'],
    ['/source/forced/0'],
    ['/source/forced'],
  ]);
});

test('run: claim holds whether the claim took and the state the provider reported, and nothing else', () => {
  const claimed = (claim: unknown) => validateDocument('sail.run.v1', { ...run, claim });
  const issue = (path: string, message: string) => [{ schema: 'sail.run.v1' as const, path, message }];
  const state = { type: 'completed', name: 'Done' };
  expect(claimed({ claimed: false, state })).toEqual([]);
  expect(claimed({ claimed: true })).toEqual(issue('/claim/state', 'is required'));
  expect(claimed({ state })).toEqual(issue('/claim/claimed', 'is required'));
  expect(claimed({ claimed: true, state, runId: RUN_ID })).toEqual(issue('/claim/runId', 'is not allowed'));
  expect(
    paths('sail.run.v1', { ...run, claim: { claimed: true, state: { type: 'in-progress', name: 'Doing' } } }),
  ).toEqual(['/claim/state/type']);
});

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ('run: a header with no claim is refused, naming claim', () => {
  expect(validateDocument('sail.run.v1', omit(run, 'claim'))).toEqual([
    { schema: 'sail.run.v1', path: '/claim', message: 'is required' },
  ]);
});

test('event: run:start takes source.forced as the list, and refuses a boolean', () => {
  expect(forcedIssues('sail.event.v1', event, ['designation', 'state'])).toEqual([]);
  expect(forcedIssues('sail.event.v1', event, false)).toEqual(['/source/forced']);
  expect(forcedIssues('sail.event.v1', event, ['label'])).toEqual(['/source/forced/0']);
});
