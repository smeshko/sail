import { afterEach, expect, test } from 'bun:test';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import type { NewEvent, NewQueueEvent } from '../../src/events/types';
import { stepEnd as stepEndEvent, stepStart as stepStartEvent } from '../helpers/events';
import { writeTwoStepRun } from '../helpers/run-dir';

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
/** An agent's message: an event whose payload is closed, as every run event's is. */
const message = { ...envelope, type: 'agent:message', key: 'spec#1', text: 'hi' };
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

test('a roster entry lists its tools by name, in run.json and in run:start, each a non-empty string', () => {
  const tools = ['WebFetch', 'linear:get_issue', 'github:*'];
  const entry = (permissions: unknown) => ({ spec: { kind: 'agent', origin: 'repo:.sail/stages/spec', permissions } });
  const listing = { read: ['**'], write: ['$STAGE_OUT/**'], commands: [], tools };
  expect(validateDocument('sail.run.v1', { ...run, stages: entry(listing) })).toEqual([]);
  expect(
    validateDocument('sail.event.v1', { ...event, roster: { ...runStart.roster, stages: entry(listing) } }),
  ).toEqual([]);
  expect(paths('sail.run.v1', { ...run, stages: entry({ tools: [1, ''] }) })).toEqual([
    '/stages/spec/permissions/tools/0',
    '/stages/spec/permissions/tools/1',
  ]);
});

test('permission:denied names tools as its rule, with the tools the step lists; mcp is no rule', () => {
  const denied = {
    ...envelope,
    type: 'permission:denied',
    key: 'implement#1',
    callId: 'tool-9',
    tool: 'get_issue',
    rule: 'tools',
    permissions: { tools: [] },
    reason: "linear:get_issue is not among the step's tools",
  };
  expect(validateDocument('sail.event.v1', denied)).toEqual([]);
  expect(paths('sail.event.v1', { ...denied, rule: 'mcp' })).toEqual(['/rule']);
});

test('event: the type is exhaustive, and runId is required', () => {
  expect(paths('sail.event.v1', message)).toEqual([]);
  expect(paths('sail.event.v1', { ...message, type: 'agent:thought' })).toEqual(['/type']);
  expect(paths('sail.event.v1', omit(message, 'runId'))).toEqual(['/runId']);
});

test("event: all:start and all:end carry a group's keys, and refuse a missing or empty keys, a key that isn't a call's, an unknown outcome and a field they don't declare", () => {
  const start = { ...envelope, type: 'all:start', keys: ['style#1', 'coverage#1'], running: ['coverage#1'] };
  const end = {
    ...envelope,
    type: 'all:end',
    keys: ['style#1', 'coverage#1'],
    outcomes: { 'style#1': 'done', 'coverage#1': 'error' },
    durationMs: 612,
  };
  expect([paths('sail.event.v1', start), paths('sail.event.v1', end)]).toEqual([[], []]);
  expect(paths('sail.event.v1', omit(start, 'keys'))).toEqual(['/keys']);
  expect(paths('sail.event.v1', { ...start, running: [] })).toEqual(['/running']);
  expect(paths('sail.event.v1', { ...start, keys: ['style#1/review'] })).toEqual(['/keys/0']);
  expect(paths('sail.event.v1', { ...end, outcomes: { 'style#1': 'maybe' } })).toEqual(['/outcomes/style#1']);
  expect(paths('sail.event.v1', omit(end, 'durationMs'))).toEqual(['/durationMs']);
  expect(paths('sail.event.v1', { ...end, key: 'style#1' })).toEqual(['/key']);
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
    try: 1,
    command: '.sail/workflows/ticket-to-pr/stages/publish/open.sh',
  },
  {
    type: 'step:end',
    key: 'publish#1/open',
    step: 'open',
    try: 1,
    outcome: 'passed',
    durationMs: 1000,
    resultPath: '05-publish/call-1/steps/2-open/result.json',
  },
  {
    type: 'step:queued',
    key: KEY,
    exclusive: 'verify',
    holder: { runId: 'HOLDER-1', key: 'verify#1', pid: 4242, takenAt: '2026-10-27T09:00:00.000Z' },
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
  'step:queued',
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
    expect(CALL_LEVEL.size).toBe(16);
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
/** The intake's fetch, which names its ticket by its title and URL. */
const FETCHED: NewEvent = {
  type: 'ticket:fetched',
  key: 'intake#1',
  ticketKey: 'FAKE-1',
  title: 'Add a --shout flag to the greet command',
  url: 'fake://tickets/FAKE-1',
  comments: 1,
  links: 0,
  attachments: 0,
  durationMs: 310,
};

/** One sample of each other provider type. */
const PROVIDER: NewEvent[] = [
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
  {
    type: 'ticket:created',
    key: OPEN,
    ticketKey: 'FAKE-2',
    title: 'Follow up on the --shout flag',
    url: 'fake://tickets/FAKE-2',
  },
  {
    type: 'ticket:attached',
    key: OPEN,
    ticketKey: 'FAKE-1',
    name: 'transcript.txt',
    contentType: 'text/plain',
    size: 42,
    url: 'fake://tickets/FAKE-1/attachments/1',
  },
  { type: 'ticket:labelled', key: OPEN, ticketKey: 'FAKE-1', label: 'Bug', labels: ['sail', 'Bug'] },
  { type: 'ticket:unlabelled', key: OPEN, ticketKey: 'FAKE-1', label: 'Bug', labels: ['sail'] },
  {
    type: 'ticket:related',
    key: OPEN,
    ticketKey: 'FAKE-2',
    kind: 'duplicate',
    to: 'FAKE-1',
    state: { type: 'canceled', name: 'Duplicate' },
  },
  { type: 'ticket:edited', key: OPEN, ticketKey: 'FAKE-1', fields: ['title', 'description'] },
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
  { type: 'codehost:checks_rerun', key: OPEN, number: 1, headSha: SHA, checks: ['ci'] },
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

test('ticket:fetched accepts its provider payload, with its title and URL, and rejects a field it does not declare', () => {
  expect(validateDocument('sail.event.v1', stamped(FETCHED))).toEqual([]);
  expect(validateDocument('sail.event.v1', { ...stamped(FETCHED), surprise: 1 })).toEqual([
    { schema: 'sail.event.v1', path: '/surprise', message: 'is not allowed' },
  ]);
});

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
  expect([
    check({ type: 'codehost:checks_rerun', number: 1, headSha: SHA, checks: ['ci'] }),
    check({ type: 'codehost:checks_rerun', number: 1, headSha: SHA, checks: ['ci'], extra: true }),
    check({ type: 'codehost:checks_rerun', number: 1, headSha: SHA, checks: [] }),
  ]).toEqual([[], issue('/extra', 'is not allowed'), issue('/checks', 'must NOT have fewer than 1 items')]);
});

test('event: a run:suspended on the usage limit names its call and may carry the reset time, and takes no budget field', () => {
  const check = (sample: Record<string, unknown>) =>
    paths('sail.event.v1', { ...envelope, type: 'run:suspended', ...sample }).sort();
  const limited = { stopReason: 'usage_limit', key: 'spec#1', resetsAt: '2026-10-28T14:20:00.000Z' };
  expect({
    limited: check(limited),
    noReset: check({ stopReason: 'usage_limit', key: 'spec#1' }),
    noKey: check({ stopReason: 'usage_limit' }),
    badReset: check({ ...limited, resetsAt: 'tomorrow' }),
    withBudget: check({ ...limited, budget: 'usd' }),
    runEnd: paths('sail.event.v1', {
      ...envelope,
      type: 'run:end',
      status: 'suspended',
      stopReason: 'usage_limit',
      replays: 1,
    }),
  }).toEqual({
    limited: [],
    noReset: [],
    noKey: ['/key'],
    badReset: ['/resetsAt'],
    withBudget: ['/budget'],
    runEnd: [],
  });
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
  expect(paths('sail.summary.v1', { ...summary, status: 'suspended', stopReason: 'usage_limit' })).toEqual([]);
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
  expect(paths('sail.result.v1', { ...multiStepResult, steps: [] })).toEqual(['/steps']);
});

test('result: a script result declares no codeHost, which nothing writes: one that carries it is refused, naming it', () => {
  const issues = validateDocument('sail.result.v1', { ...scriptResult, codeHost: { operation: 'merge' } });
  expect(issues.map((issue) => [issue.path, issue.message])).toEqual([['/codeHost', 'is not allowed']]);
  expect(validateDocument('sail.result.v1', scriptResult)).toEqual([]);
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
    'usage_limit',
    'harness',
  ];
  const every = reasons.map((reason) => ({ reason, message: reason }));
  expect(paths('sail.result.v1', { ...failing, errors: every })).toEqual([]);
});

test('event: a run:suspended on an unavailable port names its call, and takes no reset time or budget field', () => {
  const check = (sample: Record<string, unknown>) =>
    paths('sail.event.v1', { ...envelope, type: 'run:suspended', ...sample }).sort();
  const down = { stopReason: 'port_unavailable', key: 'publish#1' };
  expect({
    down: check(down),
    noKey: check({ stopReason: 'port_unavailable' }),
    withReset: check({ ...down, resetsAt: '2026-10-28T14:20:00.000Z' }),
    withBudget: check({ ...down, budget: 'usd' }),
    runEnd: paths('sail.event.v1', {
      ...envelope,
      type: 'run:end',
      status: 'suspended',
      stopReason: 'port_unavailable',
      replays: 1,
    }),
  }).toEqual({
    down: [],
    noKey: ['/key'],
    withReset: ['/resetsAt'],
    withBudget: ['/budget'],
    runEnd: [],
  });
});

test('result: a port error may carry the code unavailable, and no other code', () => {
  const failing = { ...scriptResult, outcome: 'error' };
  const port = { reason: 'port', message: 'codeHost.push: GitHub is unreachable' };
  expect({
    unavailable: paths('sail.result.v1', { ...failing, errors: [{ ...port, code: 'unavailable' }] }),
    other: paths('sail.result.v1', { ...failing, errors: [{ ...port, code: 'not_found' }] }),
  }).toEqual({ unavailable: [], other: ['/errors/0/code'] });
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
    validateDocument('sail.result.v1', {
      ...multiStepResult,
      outcome: 'blocked',
      reason: 'nothing to finish',
      steps: [openStep, blockedLast],
    }),
  ).toEqual([]);
});

test('result: a multi-step call lists the steps that ran, at least one: a call its first step stopped validates, and one with no steps does not', () => {
  const stopped = {
    ...multiStepResult,
    outcome: 'blocked',
    reason: 'the spec names no change to describe',
    output: null,
    steps: [{ ...describeStep, outcome: 'blocked' }],
  };
  expect(validateDocument('sail.result.v1', stopped)).toEqual([]);
  expect(paths('sail.result.v1', { ...stopped, steps: [] })).toEqual(['/steps']);
});

test('result: a blocked multi-step call gives its reason, and one that is not blocked gives none', () => {
  const blocked = {
    ...multiStepResult,
    outcome: 'blocked',
    output: null,
    steps: [{ ...describeStep, outcome: 'blocked' }],
  };
  expect(paths('sail.result.v1', blocked)).toEqual(['/reason']);
  expect(paths('sail.result.v1', { ...blocked, reason: ' ' })).toEqual(['/reason']);
  expect(paths('sail.result.v1', { ...multiStepResult, reason: 'no reason to give' })).toEqual(['/reason']);
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

test('project.yaml: models take a model id or a { harness, model } object, and adapters.harnesses takes adapter entries', async () => {
  const text = await Bun.file(fixtureProject).text();
  const withDeep = (deep: string) => text.replace('deep: claude-opus-5-5', `deep: ${deep}`);
  const withHarnesses = (deep: string, harnesses: string) =>
    withDeep(deep).replace('  workspace: { use: fake }\n', `  workspace: { use: fake }\n  harnesses: ${harnesses}\n`);
  expect(projectIssues(withHarnesses('{ harness: second, model: x }', '{ second: { use: fake } }'))).toEqual([]);
  expect(projectIssues(withDeep('{ harness: second }'))).toContain('/models/deep/model');
  expect(projectIssues(withDeep('{ model: x }'))).toContain('/models/deep/harness');
  expect(projectIssues(withDeep('{ harness: second, model: x, effort: high }'))).toContain('/models/deep/effort');
  expect(projectIssues(withDeep('{ harness: Second, model: x }'))).toContain('/models/deep/harness');
  expect(projectIssues(withDeep('""'))).toContain('/models/deep');
  expect(projectIssues(withHarnesses('claude-opus-5-5', '{ Second: { use: fake } }'))).toEqual([
    '/adapters/harnesses/Second',
  ]);
  expect(projectIssues(withHarnesses('claude-opus-5-5', '{ second: { model: x } }'))).toEqual([
    '/adapters/harnesses/second/use',
  ]);
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

test("result: a built-in intake's claim holds whether the claim took and the state the provider reported, and nothing else", () => {
  const claimed = (claim: unknown) => validateDocument('sail.result.v1', { ...builtinResult, claim });
  const issue = (path: string, message: string) => [{ schema: 'sail.result.v1' as const, path, message }];
  const state = { type: 'started', name: 'In Progress' };
  expect(claimed({ claimed: true, state })).toEqual([]);
  expect(claimed({ claimed: true })).toEqual(issue('/claim/state', 'is required'));
  expect(claimed({ state })).toEqual(issue('/claim/claimed', 'is required'));
  expect(claimed({ claimed: true, state, runId: RUN_ID })).toEqual(issue('/claim/runId', 'is not allowed'));
  expect(
    paths('sail.result.v1', { ...builtinResult, claim: { claimed: true, state: { type: 1, name: 'Doing' } } }),
  ).toEqual(['/claim/state/type']);
  expect(
    paths('sail.result.v1', {
      ...builtinResult,
      claim: { claimed: true, state: { type: 'in-progress', name: 'Doing' } },
    }),
  ).toEqual(['/claim/state/type']);
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
  const stepStart = {
    ...envelope,
    type: 'step:start',
    key: OPEN,
    stage: 'publish',
    step: 'open',
    index: 2,
    of: 2,
    try: 1,
  };
  expect(paths('sail.event.v1', { ...stepStart, kind: 'script' })).toEqual([]);
  expect(paths('sail.event.v1', { ...stepStart, kind: 'builtin' })).toEqual(['/kind']);
});

test("event: an intake:start of a repository's intake takes the kind stage with its steps, and no other kind", () => {
  const intakeStart = {
    ...envelope,
    type: 'intake:start',
    key: 'intake#1',
    intake: 'groom',
    origin: 'repo:.sail/workflows/groom',
    consumed: { source: 'run.json#/source' },
  };
  expect(paths('sail.event.v1', { ...intakeStart, kind: 'stage', steps: ['fetch', 'shape'] })).toEqual([]);
  expect(paths('sail.event.v1', { ...intakeStart, kind: 'script' })).toEqual([]);
  expect(paths('sail.event.v1', { ...intakeStart, kind: 'pipeline', steps: ['fetch', 'shape'] })).toEqual(['/kind']);
  expect(paths('sail.event.v1', { ...intakeStart, kind: 'stage', steps: [1, 2] })).not.toEqual([]);
});

test("event: a step's start and end carry its try, as a call's do", () => {
  const start = stamped(stepStartEvent(OPEN, 2, 2, 'script', 2));
  const end = stamped(stepEndEvent(OPEN, 2, 'passed', 2));
  expect([validateDocument('sail.event.v1', start), validateDocument('sail.event.v1', end)]).toEqual([[], []]);
  expect(validateDocument('sail.event.v1', omit(start, 'try'))).toEqual([
    { schema: 'sail.event.v1', path: '/try', message: 'is required' },
  ]);
  expect(validateDocument('sail.event.v1', omit(end, 'try'))).toEqual([
    { schema: 'sail.event.v1', path: '/try', message: 'is required' },
  ]);
});

test('event: a step:end carries its errors exactly when the step ended in error', () => {
  const failed = stamped(stepEndEvent(OPEN, 2, 'error'));
  expect(validateDocument('sail.event.v1', { ...failed, errors: [portError] })).toEqual([]);
  expect(paths('sail.event.v1', failed)).toEqual(['/errors']);
  expect(paths('sail.event.v1', { ...stamped(stepEndEvent(OPEN, 2, 'passed')), errors: [portError] })).toEqual([
    '/errors',
  ]);
});

test("event: a step:end's durationMs is optional, and a number of 0 or more", () => {
  const end = stamped(stepEndEvent(OPEN, 2, 'passed'));
  expect(paths('sail.event.v1', end)).toEqual([]);
  expect(paths('sail.event.v1', { ...end, durationMs: 0 })).toEqual([]);
  expect(paths('sail.event.v1', { ...end, durationMs: 1250 })).toEqual([]);
  expect(paths('sail.event.v1', { ...end, durationMs: -1 })).toEqual(['/durationMs']);
  expect(paths('sail.event.v1', { ...end, durationMs: '1250' })).toEqual(['/durationMs']);
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

test('run: a header with no claim is valid, since opening a run claims nothing', () => {
  expect(validateDocument('sail.run.v1', omit(run, 'claim'))).toEqual([]);
});

// A seeded run (D5): its header names the run it reused calls from.

test('run: a seeded header names its fromRun; an empty fromRun is refused', () => {
  const seeded = { ...omit(run, 'claim'), fromRun: RUN_ID };
  expect(validateDocument('sail.run.v1', seeded)).toEqual([]);
  expect(paths('sail.run.v1', { ...seeded, fromRun: '' })).toEqual(['/fromRun']);
});

test('event: run:start and journal:append take a fromRun naming a run, and refuse an empty one', () => {
  const append = { ...envelope, type: 'journal:append', key: 'intake#1', line: 1, outcome: 'passed' };
  expect([
    paths('sail.event.v1', { ...event, fromRun: RUN_ID }),
    paths('sail.event.v1', { ...append, fromRun: RUN_ID }),
    paths('sail.event.v1', { ...event, fromRun: '' }),
    paths('sail.event.v1', { ...append, fromRun: '' }),
  ]).toEqual([[], [], ['/fromRun'], ['/fromRun']]);
});

/**
 * The golden run as a seeded run would hold it: a header with `fromRun` and no claim, the journal's first `reused` lines
 * reported as reused calls (`journal:append` with `fromRun`), and every other result naming the seeded run.
 */
function seededRunDir(reused: number, fromRun = RUN_ID): { dir: string; seededId: string } {
  const dir = tempDir({});
  const golden = join(root, 'test', 'fixtures', 'runs', RUN_ID);
  cpSync(golden, dir, { recursive: true });
  const seededId = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3P';
  const header = JSON.parse(readFileSync(join(golden, 'run.json'), 'utf8'));
  chmodSync(join(dir, 'run.json'), 0o644);
  writeFileSync(join(dir, 'run.json'), json({ ...omit(header, 'claim'), runId: seededId, fromRun: RUN_ID }));
  const lines = readFileSync(join(dir, 'events.ndjson'), 'utf8')
    .split('\n')
    .filter((text) => text !== '');
  const events = lines.map((text) => JSON.parse(text));
  writeFileSync(
    join(dir, 'events.ndjson'),
    ndjson(...events.map((e) => (e.type === 'journal:append' && e.line <= reused ? { ...e, fromRun } : e))),
  );
  const journal = readFileSync(join(dir, 'journal.ndjson'), 'utf8')
    .split('\n')
    .filter((text) => text !== '');
  for (const entry of journal.map((text) => JSON.parse(text)).slice(reused)) setRunId(dir, entry.resultPath, seededId);
  return { dir, seededId };
}

function setRunId(dir: string, resultPath: string, runId: string): void {
  const path = join(dir, resultPath);
  writeFileSync(path, json({ ...JSON.parse(readFileSync(path, 'utf8')), runId }));
}

/** Each issue as its file and line, and whether it says the result names another run than `seededId`. */
const issuesOf = (dir: string, seededId: string) =>
  validateRunDir(dir).issues.map((issue) => [
    issue.file,
    issue.line,
    issue.message.endsWith(`not "${seededId}")`) ? 'names another run' : issue.message,
  ]);

test('a seeded run directory may hold results that name the run it came from, only on the journal lines its events report as reused', () => {
  const valid = seededRunDir(3);
  // A fresh line whose result names another run is no reused call (review R1-2).
  const fresh = seededRunDir(3);
  setRunId(fresh.dir, '03-tests/call-1/result.json', RUN_ID);
  // Reused lines its events don't report: here, all of them.
  const unreported = seededRunDir(0);
  for (const resultPath of ['00-intake/call-1/result.json', '01-spec/call-1/result.json'])
    setRunId(unreported.dir, resultPath, RUN_ID);
  expect([
    issuesOf(valid.dir, valid.seededId),
    issuesOf(fresh.dir, fresh.seededId),
    issuesOf(unreported.dir, unreported.seededId),
  ]).toEqual([
    [],
    [['journal.ndjson', 4, 'names another run']],
    [
      ['journal.ndjson', 1, 'names another run'],
      ['journal.ndjson', 2, 'names another run'],
    ],
  ]);
});

test('a reused call reported for another run than the header names, or after a call of the run, is an issue of the events file', () => {
  const other = seededRunDir(2, 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3Q');
  const gap = seededRunDir(3);
  const path = join(gap.dir, 'events.ndjson');
  const events = readFileSync(path, 'utf8')
    .split('\n')
    .filter((text) => text !== '')
    .map((text) => JSON.parse(text));
  // Line 2 reported as this run's own call, so the reused line 3 comes after it.
  writeFileSync(
    path,
    ndjson(...events.map((e) => (e.type === 'journal:append' && e.line === 2 ? omit(e, 'fromRun') : e))),
  );
  setRunId(gap.dir, '01-spec/call-1/result.json', gap.seededId);
  const messages = (dir: string) =>
    validateRunDir(dir)
      .issues.filter((issue) => issue.file === 'events.ndjson')
      .map((issue) => issue.message);
  expect([messages(other.dir), messages(gap.dir)]).toEqual([
    [
      `reports a reused call from run FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3Q, but run.json's fromRun is ${RUN_ID}`,
      `reports a reused call from run FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3Q, but run.json's fromRun is ${RUN_ID}`,
    ],
    ["reports journal line 3 as a reused call after a call of the run: reused calls are the journal's first lines"],
  ]);
});

test('event: run:start takes source.forced as the list, and refuses a boolean', () => {
  expect(forcedIssues('sail.event.v1', event, ['designation', 'state'])).toEqual([]);
  expect(forcedIssues('sail.event.v1', event, false)).toEqual(['/source/forced']);
  expect(forcedIssues('sail.event.v1', event, ['label'])).toEqual(['/source/forced/0']);
});

test('event: a ticket:fetched names its ticket: one without title, or without url, breaks sail.event.v1, with a key and without one', () => {
  const fetched = {
    seq: 1,
    ts: '2026-09-25T09:00:00.000Z',
    runId: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N',
    type: 'ticket:fetched',
    ticketKey: 'FAKE-1',
    title: 'Add a --shout flag to the greet command',
    url: 'fake://tickets/FAKE-1',
    comments: 1,
    links: 0,
    attachments: 0,
    durationMs: 310,
  };
  const issues = (event: object) =>
    validateDocument('sail.event.v1', event).map((issue) => `${issue.path} ${issue.message}`);
  expect([issues(fetched), issues({ ...fetched, key: 'intake#1' })]).toEqual([[], []]);
  for (const key of [{}, { key: 'intake#1' }]) {
    const { title: _title, ...untitled } = { ...fetched, ...key };
    const { url: _url, ...unlinked } = { ...fetched, ...key };
    expect([issues(untitled), issues(unlinked)]).toEqual([['/title is required'], ['/url is required']]);
    expect(issues({ ...fetched, ...key, title: 7 })).toEqual(['/title must be string']);
  }
});

// A two-step call in a run directory (D9), on a run directory written by hand: the engine can't run a multi-step stage
// yet, so no run, and no golden run, holds one.

/** The hand-written two-step run, in a temporary directory of its own. */
function twoStepRun(): string {
  const dir = tempDir({});
  writeTwoStepRun(dir);
  return dir;
}

const PUBLISH = '05-publish/call-1';
const readJson = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'));
/** Rewrites the JSON document at `path` in `dir` as `change` leaves it. */
function rewrite(dir: string, path: string, change: (data: Record<string, unknown>) => unknown): void {
  writeFileSync(join(dir, path), json(change(readJson(dir, path))));
}

test('a run directory that holds a two-step call, its two step results, its three journal lines and its events passes validateRunDir with no issue', () => {
  const dir = twoStepRun();
  expect(validateRunDir(dir)).toEqual({
    counts: {
      'sail.run.v1': 1,
      'sail.journal.v1': 3,
      'sail.event.v1': 31,
      'sail.summary.v1': 1,
      'sail.result.v1': 3,
    },
    issues: [],
  });
  expect(readJson(dir, `${PUBLISH}/result.json`).steps.map((step: { step: string }) => step.step)).toEqual([
    'describe',
    'open',
  ]);
});

test("a multi-step call's outcome is its last step's, as that step's result.json records it: a step result that says otherwise is named by the call's link and by its own journal line", () => {
  const dir = twoStepRun();
  const call = readJson(dir, `${PUBLISH}/result.json`);
  const last = call.steps.at(-1);
  expect([call.outcome, last.outcome, readJson(dir, last.resultPath).outcome]).toEqual(['passed', 'passed', 'passed']);

  rewrite(dir, last.resultPath, (result) => ({ ...result, outcome: 'failed', exit: { code: 1, mapped: 'failed' } }));
  expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([
    `journal.ndjson:2  [sail.journal.v1]  /resultPath points at ${PUBLISH}/steps/2-open/result.json, which differs in outcome ("failed", not "passed")`,
    `${PUBLISH}/result.json  [sail.result.v1]  /steps/1/resultPath points at ${PUBLISH}/steps/2-open/result.json, which differs in outcome ("failed", not "passed")`,
  ]);
});

test("a multi-step call linked to another call's result names the link, and each field that differs", () => {
  const dir = twoStepRun();
  // Another call of the run, journaled as a call is: tests#2.
  const other = { ...scriptResult, stage: 'tests', call: 2, key: 'tests#2' };
  mkdirSync(join(dir, '03-tests', 'call-2'), { recursive: true });
  writeFileSync(join(dir, '03-tests', 'call-2', 'result.json'), json(other));
  const line = {
    ...journal,
    seq: 4,
    key: 'tests#2',
    stage: 'tests',
    call: 2,
    resultPath: '03-tests/call-2/result.json',
  };
  writeFileSync(join(dir, 'journal.ndjson'), `${readFileSync(join(dir, 'journal.ndjson'), 'utf8')}${ndjson(line)}`);
  expect(validateRunDir(dir).issues).toEqual([]);

  rewrite(dir, `${PUBLISH}/result.json`, (result) => {
    const [describe, open] = result.steps as Record<string, unknown>[];
    return { ...result, steps: [describe, { ...open, resultPath: '03-tests/call-2/result.json' }] };
  });
  expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([
    `${PUBLISH}/result.json  [sail.result.v1]  /steps/1/resultPath points at 03-tests/call-2/result.json, ` +
      'which differs in key ("tests#2", not "publish#1/open"), stage ("tests", not "publish"), call (2, not 1), ' +
      'step (undefined, not "open")',
  ]);
});

// A queue's event stream: the run's envelope without runId, with the watched workflow (DECISIONS D4).
const queueEnvelope = { seq: 1, ts: TS };
const QUEUED: NewQueueEvent[] = [
  { type: 'queue:polled', workflow: 'ticket-to-pr', kind: 'ticket', label: 'sail', found: 3, added: 2, durationMs: 41 },
  {
    type: 'queue:item_added',
    workflow: 'ticket-to-pr',
    dedupKey: 'ticket:FAKE-1',
    source: { kind: 'ticket', ticketKey: 'FAKE-1' },
    title: 'Add a --shout flag to the greet command',
  },
  { type: 'queue:parked', workflow: 'ticket-to-pr', dedupKey: 'ticket:FAKE-1', attempts: 2, reason: 'spec blocked' },
  {
    type: 'queue:error',
    workflow: 'ticket-to-pr',
    port: 'ticketSource',
    adapter: 'linear',
    code: 'unauthorized',
    message: 'ticketSource.listDesignated: Authentication required',
    paused: true,
  },
];

test.each(QUEUED.map((sample) => [sample.type, sample] as const))(
  '%s accepts its payload without runId, and rejects a field it does not declare',
  (_, sample) => {
    expect(validateDocument('sail.event.v1', { ...queueEnvelope, ...sample })).toEqual([]);
    expect(validateDocument('sail.event.v1', { ...queueEnvelope, ...sample, surprise: 1 })).toEqual([
      { schema: 'sail.event.v1', path: '/surprise', message: 'is not allowed' },
    ]);
  },
);

test('a queue event refuses a runId, needs its workflow, and keeps retryInMs and dedupKey to their rules', () => {
  const [polled, added, , error] = QUEUED.map((sample) => ({ ...queueEnvelope, ...sample }));
  expect(paths('sail.event.v1', { ...polled, runId: RUN_ID })).toEqual(['/runId']);
  expect(paths('sail.event.v1', omit(polled as Record<string, unknown>, 'workflow'))).toEqual(['/workflow']);
  expect(paths('sail.event.v1', { ...error, retryInMs: 60_000 })).toEqual(['/retryInMs']);
  expect(paths('sail.event.v1', { ...error, paused: false })).toEqual(['/retryInMs']);
  expect(paths('sail.event.v1', { ...error, paused: false, retryInMs: 60_000 })).toEqual([]);
  expect(paths('sail.event.v1', { ...added, dedupKey: 'FAKE-1' })).toEqual(['/dedupKey']);
});

// The watch set's changes and the dispatch's events, closed in 13.2 (DECISIONS D7, D8, D12).
const RUN_OF_FAKE_1 = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const WATCHED: NewQueueEvent[] = [
  { type: 'watch:added', workflow: 'ticket-to-pr', pid: 4242, label: 'sail', everyMs: 30_000, maxConcurrentRuns: 2 },
  { type: 'watch:removed', workflow: 'ticket-to-pr', pid: 4242 },
  {
    type: 'queue:dispatched',
    workflow: 'ticket-to-pr',
    dedupKey: 'ticket:FAKE-1',
    run: RUN_OF_FAKE_1,
    attempt: 1,
    pid: 4243,
  },
  {
    type: 'queue:skipped_leased',
    workflow: 'ticket-to-pr',
    dedupKey: 'ticket:FAKE-3',
    branch: 'sail/FAKE-3-document-the-greet-command',
    heldBy: RUN_OF_FAKE_1,
  },
  { type: 'queue:dropped', workflow: 'ticket-to-pr', dedupKey: 'ticket:FAKE-4', reason: 'it is In Progress' },
];

/** Each way a sample breaks sail.event.v1, as the paths of its issues. */
const broken = (sample: NewQueueEvent, change: Record<string, unknown>, without?: string) => {
  const event: Record<string, unknown> = { ...queueEnvelope, ...sample, ...change };
  return paths('sail.event.v1', without === undefined ? event : omit(event, without));
};

test('the watch and dispatch queue events validate closed, without runId, and each refuses an extra field', () => {
  expect(WATCHED.map((sample) => [sample.type, paths('sail.event.v1', { ...queueEnvelope, ...sample })])).toEqual(
    WATCHED.map((sample) => [sample.type, []]),
  );
  expect(WATCHED.map((sample) => broken(sample, { surprise: 1 }))).toEqual(WATCHED.map(() => ['/surprise']));
  expect(WATCHED.map((sample) => broken(sample, { runId: RUN_ID }))).toEqual(WATCHED.map(() => ['/runId']));
});

test('the watch and dispatch queue events refuse a missing field, a pid or attempt below 1, and an empty reason, label or branch', () => {
  const [added, removed, dispatched, skipped, dropped] = WATCHED as [NewQueueEvent, ...NewQueueEvent[]];
  expect({
    addedNoLabel: broken(added, {}, 'label'),
    addedEmptyLabel: broken(added, { label: '' }),
    addedPid: broken(added, { pid: 0 }),
    addedEvery: broken(added, { everyMs: 29_999 }),
    addedCap: broken(added, { maxConcurrentRuns: 0 }),
    removedNoPid: broken(removed as NewQueueEvent, {}, 'pid'),
    dispatchedNoRun: broken(dispatched as NewQueueEvent, {}, 'run'),
    dispatchedAttempt: broken(dispatched as NewQueueEvent, { attempt: 0 }),
    dispatchedPid: broken(dispatched as NewQueueEvent, { pid: 0 }),
    dispatchedKey: broken(dispatched as NewQueueEvent, { dedupKey: 'FAKE-1' }),
    skippedBranch: broken(skipped as NewQueueEvent, { branch: '' }),
    skippedNoHolder: broken(skipped as NewQueueEvent, {}, 'heldBy'),
    droppedReason: broken(dropped as NewQueueEvent, { reason: ' ' }),
    droppedNoWorkflow: broken(dropped as NewQueueEvent, {}, 'workflow'),
  }).toEqual({
    addedNoLabel: ['/label'],
    addedEmptyLabel: ['/label'],
    addedPid: ['/pid'],
    addedEvery: ['/everyMs'],
    addedCap: ['/maxConcurrentRuns'],
    removedNoPid: ['/pid'],
    dispatchedNoRun: ['/run'],
    dispatchedAttempt: ['/attempt'],
    dispatchedPid: ['/pid'],
    dispatchedKey: ['/dedupKey'],
    skippedBranch: ['/branch'],
    skippedNoHolder: ['/heldBy'],
    droppedReason: ['/reason'],
    droppedNoWorkflow: ['/workflow'],
  });
});

// What the watcher did with a dispatched run, and a requeue by hand, closed in 13.3 (DECISIONS D3, D8).
const RECONCILED: NewQueueEvent[] = [
  { type: 'run:adopted', workflow: 'ticket-to-pr', dedupKey: 'ticket:FAKE-1', run: RUN_OF_FAKE_1, pid: 4243 },
  {
    type: 'run:resumed',
    workflow: 'ticket-to-pr',
    dedupKey: 'ticket:FAKE-1',
    run: RUN_OF_FAKE_1,
    pid: 4244,
    from: { status: 'running' },
  },
  {
    type: 'run:resumed',
    workflow: 'ticket-to-pr',
    dedupKey: 'ticket:FAKE-1',
    run: RUN_OF_FAKE_1,
    pid: 4245,
    from: { status: 'suspended', stopReason: 'unwatched' },
  },
  { type: 'queue:requeued', workflow: 'ticket-to-pr', dedupKey: 'ticket:FAKE-2', reason: 'requeued by hand' },
];

test('run:adopted, run:resumed and queue:requeued validate closed in a queue stream, without runId, and each refuses an extra field and a runId', () => {
  expect({
    valid: RECONCILED.map((sample) => paths('sail.event.v1', { ...queueEnvelope, ...sample })),
    surprise: RECONCILED.map((sample) => broken(sample, { surprise: 1 })),
    runId: RECONCILED.map((sample) => broken(sample, { runId: RUN_ID })),
  }).toEqual({
    valid: RECONCILED.map(() => []),
    surprise: RECONCILED.map(() => ['/surprise']),
    runId: RECONCILED.map(() => ['/runId']),
  });
});

test('a run:resumed from suspended needs interrupted or unwatched, one from running takes no stop reason, a run:adopted needs its run and pid, and a requeue its reason', () => {
  const [adopted, running, suspended, requeued] = RECONCILED as [NewQueueEvent, ...NewQueueEvent[]];
  expect({
    suspendedNoReason: broken(suspended as NewQueueEvent, { from: { status: 'suspended' } }),
    suspendedUntil: broken(suspended as NewQueueEvent, { from: { status: 'suspended', stopReason: 'until' } }),
    runningWithReason: broken(running as NewQueueEvent, { from: { status: 'running', stopReason: 'interrupted' } }),
    completed: broken(running as NewQueueEvent, { from: { status: 'completed' } }),
    adoptedNoRun: broken(adopted, {}, 'run'),
    adoptedPid: broken(adopted, { pid: 0 }),
    requeuedReason: broken(requeued as NewQueueEvent, { reason: '' }),
  }).toEqual({
    suspendedNoReason: ['/from/stopReason'],
    suspendedUntil: ['/from/stopReason'],
    runningWithReason: ['/from/stopReason'],
    completed: ['/from/status'],
    adoptedNoRun: ['/run'],
    adoptedPid: ['/pid'],
    requeuedReason: ['/reason'],
  });
});

// A pull-request source (14.2's D4): its number and the head sha the run is for, and no claim, since a pull-request run
// moves no ticket.

const HEAD_SHA = 'c'.repeat(40);
const prSource = { kind: 'pr', number: 12, headSha: HEAD_SHA, via: 'watch', forced: ['state'] };
const prRun = { ...omit(run, 'claim'), runId: 'pr-12-01M3BWNZM08Q4T6V2XRJ5KWD3N', source: prSource };

test('run: a pull-request header is valid; one with a ticketKey, a short headSha or a number of 0 is refused, naming each', () => {
  const withSource = (change: Record<string, unknown>) => ({ ...prRun, source: { ...prSource, ...change } });
  expect({
    valid: paths('sail.run.v1', prRun),
    ticketKey: paths('sail.run.v1', withSource({ ticketKey: 'FAKE-1' })),
    headSha: paths('sail.run.v1', withSource({ headSha: 'abc1234' })),
    number: paths('sail.run.v1', withSource({ number: 0 })),
  }).toEqual({
    valid: [],
    ticketKey: ['/source/ticketKey'],
    headSha: ['/source/headSha'],
    number: ['/source/number'],
  });
});

test('event and summary: run:start takes a pull-request source, and summary.json one with its number and head sha; neither takes a ticketKey beside them', () => {
  const start = { ...event, runId: prRun.runId, source: prSource };
  const folded = {
    ...summary,
    runId: prRun.runId,
    source: { kind: 'pr', number: 12, headSha: HEAD_SHA, via: 'watch' },
  };
  expect({
    start: paths('sail.event.v1', start),
    summary: paths('sail.summary.v1', folded),
    startWithKey: paths('sail.event.v1', { ...start, source: { ...prSource, ticketKey: 'FAKE-1' } }),
    summaryWithKey: paths('sail.summary.v1', { ...folded, source: { ...folded.source, ticketKey: 'FAKE-1' } }),
  }).toEqual({ start: [], summary: [], startWithKey: ['/source/ticketKey'], summaryWithKey: ['/source/ticketKey'] });
});

test('queue events: queue:polled takes the kind pr, queue:item_added a pull request at its head sha with its branch, and a dedup key is pr:<number>@<sha7>, nothing looser', () => {
  const queueEnvelope = { seq: 1, ts: TS, workflow: 'review-pr' };
  const added = {
    ...queueEnvelope,
    type: 'queue:item_added',
    dedupKey: 'pr:12@ccccccc',
    source: { kind: 'pr', number: 12, headSha: HEAD_SHA, branch: 'sail/FAKE-1-x' },
    title: 'Add a greeting',
  };
  const polled = {
    ...queueEnvelope,
    type: 'queue:polled',
    kind: 'pr',
    label: 'sail',
    found: 1,
    added: 1,
    durationMs: 0,
  };
  expect({
    polled: paths('sail.event.v1', polled),
    added: paths('sail.event.v1', added),
    upper: paths('sail.event.v1', { ...added, dedupKey: 'pr:12@CCCCCCC' }),
    zero: paths('sail.event.v1', { ...added, dedupKey: 'pr:0@ccccccc' }),
    short: paths('sail.event.v1', { ...added, dedupKey: 'pr:12@cccccc' }),
    noBranch: paths('sail.event.v1', { ...added, source: { kind: 'pr', number: 12, headSha: HEAD_SHA } }),
  }).toEqual({
    polled: [],
    added: [],
    upper: ['/dedupKey'],
    zero: ['/dedupKey'],
    short: ['/dedupKey'],
    noBranch: ['/source/branch'],
  });
});

test('queue:moved validates closed in a queue stream with exactly one of before and after, each a dedup key, and a reason', () => {
  const moved: NewQueueEvent = {
    type: 'queue:moved',
    workflow: 'ticket-to-pr',
    dedupKey: 'ticket:FAKE-7',
    before: 'ticket:FAKE-5',
    reason: 'moved by hand',
  };
  expect({
    before: paths('sail.event.v1', { ...queueEnvelope, ...moved }),
    after: paths('sail.event.v1', {
      ...queueEnvelope,
      ...omit(moved as Record<string, unknown>, 'before'),
      after: 'pr:12@ccccccc',
    }),
    neither: broken(moved, {}, 'before'),
    both: broken(moved, { after: 'ticket:FAKE-6' }),
    badKey: broken(moved, { before: 'FAKE-5' }),
    reason: broken(moved, { reason: '' }),
    surprise: broken(moved, { surprise: 1 }),
    runId: broken(moved, { runId: RUN_ID }),
  }).toEqual({
    before: [],
    after: [],
    neither: ['/after'],
    both: ['/after'],
    badKey: ['/before'],
    reason: ['/reason'],
    surprise: ['/surprise'],
    runId: ['/runId'],
  });
});
