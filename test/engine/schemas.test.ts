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
const event = { seq: 1, ts: TS, type: 'run:start', runId: RUN_ID };
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
const describeStep = { step: 'describe', kind: 'agent', outcome: 'done', resultPath: 'steps/1-describe/result.json' };
const openStep = { step: 'open', kind: 'script', outcome: 'passed', resultPath: 'steps/2-open/result.json' };
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
  'events.ndjson': ndjson(event, { ...event, seq: 2, type: 'run:end', status: 'completed' }),
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

test('event: the type is exhaustive, runId is required and the payload is open', () => {
  expect(paths('sail.event.v1', { ...event, type: 'agent:thought' })).toEqual(['/type']);
  expect(paths('sail.event.v1', omit(event, 'runId'))).toEqual(['/runId']);
  expect(paths('sail.event.v1', { ...event, roster: { spec: {} }, anything: [1, 2] })).toEqual([]);
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

test('result: dispatch reports only the branch the document claims to be', () => {
  expect(validateDocument('sail.result.v1', { ...scriptResult, outcome: 'done' })).toEqual([
    { schema: 'sail.result.v1', path: '/outcome', message: 'must be equal to one of the allowed values' },
  ]);
  expect(paths('sail.result.v1', { ...agentResult, outcome: 'passed' })).toEqual(['/outcome']);
  expect(paths('sail.result.v1', { ...multiStepResult, steps: [describeStep] })).toEqual(['/steps']);
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
