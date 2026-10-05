// The agent kind: one try of an agent step. A scripted harness stands in for the port, so each test says what the
// session reports and returns, and reads back what the try sent it, emitted, recorded and left in its call directory.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFakeHarness } from '../../src/adapters/fake/harness';
import { materialisePrepared, prepareBindings, type Supplied } from '../../src/engine/bindings';
import { type CallPaths, callPaths, createCallDir } from '../../src/engine/call-dir';
import type { ContractError } from '../../src/engine/contract';
import { buildResult } from '../../src/engine/result';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import type { CallEvent } from '../../src/events/types';
import { agentKind } from '../../src/kinds/agent';
import type { AgentTry, StepContext, StepRun } from '../../src/kinds/index';
import type { Harness, HarnessEvent, HarnessRequest } from '../../src/ports/harness';
import type { HarnessResult } from '../../src/ports/types';
import { type AgentStep, agent, file, z } from '../../src/sdk/index';
import { scripted, throwing } from '../helpers/scripted-harness';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RUN_ID = 'spec-01ARYZ6S410000000000000000';
const MODEL = 'claude-opus-5-5';
const UNTRUSTED_HEADING = '## About untrusted input';
const BUILTIN = [
  { name: 'untrusted-input', origin: 'builtin' },
  { name: 'finish', origin: 'builtin' },
];

const Spec = z.object({ summary: z.string().max(400), tasks: z.array(z.string()).min(1) });
const permissions = { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git log *'] };
const budget = { maxTurns: 40, maxUsd: 2, maxMinutes: 10 };

type Options = Partial<Pick<AgentStep, 'consumes' | 'produces' | 'output' | 'budget' | 'onInvalidOutput'>>;

/** The `spec` step: it reads a brief, writes `spec.md` and submits a `Spec`, unless `options` say otherwise. */
const spec = (options: Options = {}): AgentStep =>
  agent('spec', {
    prompt: './prompt.md',
    consumes: { brief: file('brief.md') },
    produces: { 'spec.md': 'file' },
    output: Spec,
    model: 'deep',
    permissions,
    budget,
    ...options,
  });

/** A step that consumes and produces nothing, and submits against `output`. */
const bare = (output: z.ZodType): AgentStep => spec({ consumes: {}, produces: {}, output });

const VALID = { summary: 'Add a --shout flag.', tasks: ['greet()'] };
const USAGE = { inputTokens: 100, outputTokens: 20, costUsd: 0.125 };
const session = {
  sessionId: 'session-7',
  usage: USAGE,
  transcript: 'assistant: Spec written.',
  raw: { provider: 'payload' },
};
const done = (output: unknown): HarnessResult => ({ outcome: 'done', output, ...session });
const failed = (message: string, extra: object = {}) => ({
  outcome: 'error',
  message,
  ...session,
  transcript: '',
  ...extra,
});

/** Writes `text` at `path`, creating its directories. */
function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

interface Setup {
  workspace: string;
  paths: CallPaths;
  /** Every event the try emitted, in order. */
  events: CallEvent[];
  /** The context of the try, on `harness`, with its agent fields changed as `change` says. */
  context(harness: Harness, change?: Partial<AgentTry>, signal?: AbortSignal): StepContext;
  /** A file of the call directory, or null when the try left none by that name. */
  read(name: string): string | null;
}

/**
 * A workspace holding `.sail/stages/spec/` with `template` as its prompt, and try `tryNumber` of `spec#1` under
 * `.sail-runs/`, with `step`'s bindings materialised: a brief, when it consumes one.
 */
function setup(step: AgentStep, template = 'Write the spec.\n', tryNumber = 1): Setup {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'sail-agent-')));
  dirs.push(workspace);
  const stageDir = join(workspace, '.sail', 'stages', 'spec');
  write(join(stageDir, 'prompt.md'), template);
  const brief = write(join(workspace, 'docs', 'brief.md'), '# Brief\n');
  const supplied: Record<string, Supplied> =
    'brief' in step.consumes ? { brief: { kind: 'file', path: brief, from: 'docs/brief.md' } } : {};
  const runDir = join(workspace, '.sail-runs', RUN_ID);
  const paths = callPaths(runDir, 1, 'spec', 1, tryNumber);
  if (tryNumber > 1) createCallDir(callPaths(runDir, 1, 'spec', 1));
  createCallDir(paths);
  const bindings = prepareBindings(step.consumes, supplied);
  const { inputs } = materialisePrepared(bindings, paths.stageIn);
  const events: CallEvent[] = [];
  return {
    workspace,
    paths,
    events,
    context: (harness, change = {}, signal) => ({
      runId: RUN_ID,
      runDir,
      stage: 'spec',
      call: 1,
      try: tryNumber,
      stageDir,
      workspace,
      config: join(workspace, '.sail', 'project.yaml'),
      paths,
      inputs,
      emit: (event) => events.push(event),
      ...(signal === undefined ? {} : { signal }),
      agent: { harness, model: MODEL, bindings, conventions: [], validationTry: 1, ...change },
    }),
    read: (name) => (existsSync(join(paths.dir, name)) ? readFileSync(join(paths.dir, name), 'utf8') : null),
  };
}

/** Runs one try of `step` on `harness` in a setup of its own. */
async function tried(step: AgentStep, harness: Harness, template?: string): Promise<{ run: StepRun; s: Setup }> {
  const s = setup(step, template);
  return { run: await agentKind.run(step, s.context(harness)), s };
}

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
const types = (events: readonly CallEvent[]): string[] => events.map((event) => event.type);

/** The try's session ends, each without its `reason`: that is the harness's own word. */
const ends = (events: readonly CallEvent[]): object[] =>
  events.flatMap((event) => {
    if (event.type !== 'harness:session_end') return [];
    const { reason: _reason, ...end } = event;
    return [end];
  });

/** What a try that never reached a session records: no session id, no turns, no usage. */
const UNSTARTED = { adapter: 'scripted', model: MODEL, turns: 0, toolCalls: 0, denials: 0 };

test('problems() reports a produced name the engine writes, a budget out of range, an unknown onInvalidOutput and an output JSON Schema cannot hold', () => {
  expect(agentKind.kind).toBe('agent');
  expect(agentKind.problems(spec())).toEqual([]);
  expect(agentKind.problems(spec({ budget: { ...budget, maxUsd: 0 }, onInvalidOutput: 'fail' }))).toEqual([]);
  expect(agentKind.problems(spec({ produces: { 'session.log': 'file', '../spec.md': 'file' } }))).toEqual([
    "'session.log' can't be produced: the engine writes it in $STAGE_OUT",
    "'../spec.md' can't be produced: it is not a plain file name",
  ]);
  const out: [keyof typeof budget, number][] = [
    ['maxTurns', 0],
    ['maxTurns', -1],
    ['maxTurns', Number.NaN],
    ['maxMinutes', 0],
    ['maxMinutes', Number.NaN],
    ['maxUsd', -0.01],
    ['maxUsd', Number.NaN],
    ['maxUsd', Number.POSITIVE_INFINITY],
  ];
  for (const [limit, amount] of out) {
    expect(agentKind.problems(spec({ budget: { ...budget, [limit]: amount } }))).toEqual([
      expect.stringContaining(limit),
    ]);
  }
  expect(agentKind.problems(spec({ onInvalidOutput: 'retry-twice' as never }))).toEqual([
    expect.stringContaining('onInvalidOutput'),
  ]);
  expect(agentKind.problems(spec({ output: z.object({ count: z.bigint() }) }))).toEqual([
    expect.stringContaining('JSON Schema'),
  ]);
});

test('the harness receives the rendered prompt with its feedback, the preamble alone as its environment, the resolved model, the step permissions and budget, the signal, and a draft-07 schema of what to submit', async () => {
  // A transform and a refinement: the schema the agent submits against is the input's, and says nothing of either.
  const Submission = z.object({
    summary: z.string().max(400),
    points: z.string().transform((text) => Number(text)),
    tasks: z.array(z.string()).min(1),
    approved: z.boolean().refine((value) => value, { message: 'must be approved' }),
  });
  const step = spec({ output: Submission });
  const s = setup(step, 'Write the spec from {{brief}}.\n', 3);
  const harness = scripted({
    resolves: done({ ...VALID, points: '2', approved: true }),
    files: { 'spec.md': '# Spec\n' },
  });
  const controller = new AbortController();
  const feedback = ["'spec.md' was not produced in $STAGE_OUT, though {{spec}} names it"];
  const run = await agentKind.run(step, s.context(harness, { validationTry: 2, feedback }, controller.signal));

  expect(harness.requests).toHaveLength(1);
  const { onEvent, prompt, ...sent } = harness.requests[0] ?? ({} as Partial<HarnessRequest>);
  const dir = join(s.workspace, '.sail-runs', RUN_ID, '01-spec', 'call-1', 'try-3');
  expect(sent).toEqual({
    key: 'spec#1',
    try: 3,
    cwd: s.workspace,
    env: {
      RUN_ID,
      STAGE: 'spec',
      CALL: '1',
      TRY: '3',
      STAGE_IN: join(dir, 'in'),
      STAGE_OUT: dir,
      WORKSPACE: s.workspace,
      SAIL_CONFIG: join(s.workspace, '.sail', 'project.yaml'),
      INPUT_BRIEF: join(dir, 'in', 'brief.md'),
    },
    model: MODEL,
    permissions,
    budget,
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        summary: { type: 'string', maxLength: 400 },
        points: { type: 'string' },
        tasks: { type: 'array', minItems: 1, items: { type: 'string' } },
        approved: { type: 'boolean' },
      },
      required: ['summary', 'points', 'tasks', 'approved'],
    },
    signal: controller.signal,
  });
  expect(typeof onEvent).toBe('function');
  expect(prompt).toStartWith(`Write the spec from ${join(dir, 'in', 'brief.md')}.\n\n${UNTRUSTED_HEADING}\n`);
  expect(prompt?.trimEnd()).toEndWith(feedback[0] ?? '');
  expect(s.read('prompt.md')).toBe(prompt ?? '');
  expect(run.output).toEqual({ ...VALID, points: 2, approved: true });
  expect(run.record).toMatchObject({ try: 3, validationTry: 2, validationFailed: false });
});

test('a done session gives its output and the hashes of its files, and records its try, its prompt, the harness and the usage, with the transcript in session.log', async () => {
  const step = spec();
  const s = setup(step);
  write(join(s.workspace, 'AGENTS.md'), 'Indent with tabs.\n');
  const harness = scripted({ resolves: done(VALID), files: { 'spec.md': '# Spec\n' } });
  const run = await agentKind.run(step, s.context(harness, { conventions: ['AGENTS.md'] }));

  const prompt = { path: '01-spec/call-1/prompt.md', untrusted: 0, fragments: BUILTIN, conventions: ['AGENTS.md'] };
  expect(run).toEqual({
    outcome: 'done',
    output: VALID,
    files: { 'spec.md': { path: '01-spec/call-1/spec.md', bytes: 7, sha256: sha256('# Spec\n') } },
    errors: [],
    record: {
      try: 1,
      validationTry: 1,
      validationFailed: false,
      prompt,
      harness: { adapter: 'scripted', model: MODEL, sessionId: 'session-7', turns: 0, toolCalls: 0, denials: 0 },
      usage: USAGE,
    },
  });
  expect(s.read('session.log')?.trimEnd()).toBe('assistant: Spec written.');
  expect(s.read('prompt.md')).toContain('Indent with tabs.');
  expect(s.events).toEqual([
    { type: 'prompt:rendered', try: 1, ...prompt },
    expect.objectContaining({ type: 'harness:session_end', sessionId: 'session-7', outcome: 'done', usage: USAGE }),
    { type: 'output:validated' },
    { type: 'file:produced', name: 'spec.md', path: '01-spec/call-1/spec.md', bytes: 7, sha256: sha256('# Spec\n') },
  ]);
  // What the call writes from it is a valid result, and holds nothing of the provider's own answer.
  const at = new Date('2026-10-05T10:00:00.000Z');
  const result = buildResult({
    runId: RUN_ID,
    stage: 'spec',
    call: 1,
    kind: 'agent',
    run,
    consumed: { brief: 'docs/brief.md' },
    startedAt: at,
    finishedAt: at,
  });
  expect(validateDocument('sail.result.v1', result).map(formatIssue)).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('payload');
});

test('a blocked session gives its reason and no output, and owes none of its files; one with no reason, or a blank one, is invalid output', async () => {
  const reason = 'The brief has no acceptance criteria.';
  const blocked = await tried(spec(), scripted({ resolves: { outcome: 'blocked', reason, ...session } }));
  expect(blocked.run).toMatchObject({
    outcome: 'blocked',
    output: null,
    files: {},
    errors: [],
    record: { reason, validationFailed: false, usage: USAGE },
  });
  expect(types(blocked.s.events)).toEqual(['prompt:rendered', 'harness:session_end']);

  for (const without of [
    { outcome: 'blocked', ...session },
    { outcome: 'blocked', reason: ' \n\t', ...session },
  ]) {
    const { run } = await tried(spec(), scripted({ resolves: without, files: { 'spec.md': '# Spec\n' } }));
    expect({ outcome: run.outcome, output: run.output, reasons: run.errors.map((error) => error.reason) }).toEqual({
      outcome: 'error',
      output: null,
      reasons: ['invalid_output'],
    });
    expect(run.errors[0]?.message).toContain('reason');
    expect(run.record).toMatchObject({ validationFailed: true, usage: USAGE });
    expect(run.record).not.toHaveProperty('reason');
  }
});

test('a done session whose output breaks its schema, or that leaves a declared file out, ends in error with each problem, and the try runs no second session', async () => {
  const zod = '✖ Invalid input: expected string, received number\n  → at summary';
  const missing: ContractError = { reason: 'missing_file', message: "'spec.md' was not produced in $STAGE_OUT" };
  const wrong = { summary: 3, tasks: ['greet()'] };

  const invalid = scripted({ resolves: done(wrong), files: { 'spec.md': '# Spec\n' } });
  const first = await tried(spec(), invalid);
  expect(first.run).toMatchObject({ outcome: 'error', output: null, record: { validationFailed: true, usage: USAGE } });
  expect(first.run.errors).toEqual([{ reason: 'invalid_output', message: expect.stringContaining(zod) }]);
  expect(Object.keys(first.run.files)).toEqual(['spec.md']);
  expect(invalid.requests).toHaveLength(1);
  // The session ended as the harness said it did. The engine's verdict on what it submitted follows.
  expect(types(first.s.events)).toEqual(['prompt:rendered', 'harness:session_end', 'output:invalid', 'file:produced']);
  expect(ends(first.s.events)).toEqual([expect.objectContaining({ outcome: 'done' })]);
  expect(first.s.events[2]).toEqual({ type: 'output:invalid', message: first.run.errors[0]?.message ?? '' });

  const fileless = scripted({ resolves: done(VALID) });
  const second = await tried(spec(), fileless);
  expect(second.run).toMatchObject({ outcome: 'error', output: null, files: {}, record: { validationFailed: true } });
  expect(second.run.errors).toEqual([missing]);
  expect(fileless.requests).toHaveLength(1);

  const both = await tried(spec(), scripted({ resolves: done(wrong) }));
  expect(both.run.errors).toEqual([{ reason: 'invalid_output', message: expect.stringContaining(zod) }, missing]);
});

test('the engine checks what a JSON Schema cannot say: a refinement that fails, and a parsed output JSON cannot hold, are invalid output', async () => {
  const Approved = z.object({ approved: z.boolean().refine((value) => value, { message: 'must be approved' }) });
  const refused = await tried(bare(Approved), scripted({ resolves: done({ approved: false }) }));
  expect(refused.run.errors).toEqual([
    { reason: 'invalid_output', message: expect.stringContaining('✖ must be approved\n  → at approved') },
  ]);

  // Each parses, and neither can be written: JSON.stringify throws on a BigInt, and drops an undefined member.
  const Big = z.object({ count: z.number().transform((count) => BigInt(count)) });
  const Lossy = z.object({ note: z.string().transform(() => undefined) });
  const cases: [z.ZodType, unknown][] = [
    [Big, { count: 7 }],
    [Lossy, { note: 'gone' }],
  ];
  for (const [output, submitted] of cases) {
    expect(agentKind.problems(bare(output))).toEqual([]);
    const { run } = await tried(bare(output), scripted({ resolves: done(submitted) }));
    expect({ outcome: run.outcome, output: run.output, reasons: run.errors.map((error) => error.reason) }).toEqual({
      outcome: 'error',
      output: null,
      reasons: ['invalid_output'],
    });
    expect(run.record).toMatchObject({ validationFailed: true });
    expect(() => JSON.stringify(run)).not.toThrow();
  }
});

test('a prompt that cannot be rendered, or a convention that cannot be read, ends the try as not_started before any session: no prompt:rendered, an empty session.log and no usage', async () => {
  const unrendered = scripted({ resolves: done(VALID) });
  const first = await tried(spec(), unrendered, 'Intro\n\nKey: {{ticket.keey}}\n');
  expect(first.run).toEqual({
    outcome: 'error',
    output: null,
    files: {},
    errors: [
      {
        reason: 'not_started',
        message: expect.stringContaining('.sail/stages/spec/prompt.md: line 3: unknown path `ticket.keey`'),
      },
    ],
    record: { try: 1, validationTry: 1, validationFailed: false, harness: UNSTARTED, usage: { costUsd: 0 } },
  });
  expect(unrendered.requests).toEqual([]);
  expect(first.s.events).toEqual([]);
  expect([first.s.read('session.log'), first.s.read('prompt.md')]).toEqual(['', null]);

  const step = spec();
  const s = setup(step);
  const unread = scripted({ resolves: done(VALID) });
  const second = await agentKind.run(step, s.context(unread, { conventions: ['docs/MISSING.md'] }));
  expect(second.errors).toEqual([{ reason: 'not_started', message: expect.stringContaining('docs/MISSING.md') }]);
  expect(second.record).toMatchObject({ validationFailed: false, harness: UNSTARTED, usage: { costUsd: 0 } });
  expect([unread.requests, s.events, s.read('session.log')]).toEqual([[], [], '']);
});

test('a failed session, a harness that rejects or throws, and an answer that is no result are harness errors that keep their message, and a budget failure is budget_exceeded', async () => {
  const reported = { ...UNSTARTED, sessionId: 'session-7' };
  const nothing = { costUsd: 0 };
  /** Each harness, the error its try ends with, and the session and usage the try records. */
  const cases: [Harness, ContractError, object, object][] = [
    [
      scripted({ resolves: failed('model overloaded') }),
      { reason: 'harness', message: 'model overloaded' },
      reported,
      USAGE,
    ],
    [
      scripted({ resolves: failed('budget exceeded: maxTurns 1', { reason: 'budget_exceeded' }) }),
      { reason: 'budget_exceeded', message: 'budget exceeded: maxTurns 1' },
      reported,
      USAGE,
    ],
    // A session nobody reported is recorded without an id: none is made up.
    [
      scripted({ resolves: new Error('socket hang up') }),
      { reason: 'harness', message: expect.stringContaining('socket hang up') },
      UNSTARTED,
      nothing,
    ],
    [
      throwing(new Error('not configured')),
      { reason: 'harness', message: expect.stringContaining('not configured') },
      UNSTARTED,
      nothing,
    ],
    [
      scripted({ resolves: { outcome: 'finished', output: VALID } }),
      { reason: 'harness', message: expect.stringContaining('outcome') },
      UNSTARTED,
      nothing,
    ],
    // A usage the port refuses is never written: the try records none.
    [
      scripted({ resolves: { ...done(VALID), usage: { costUsd: -1 } }, files: { 'spec.md': '# Spec\n' } }),
      { reason: 'harness', message: expect.stringContaining('costUsd') },
      expect.objectContaining(UNSTARTED),
      nothing,
    ],
  ];
  for (const [harness, error, recorded, usage] of cases) {
    const { run } = await tried(spec(), harness);
    expect({ outcome: run.outcome, output: run.output, errors: run.errors }).toEqual({
      outcome: 'error',
      output: null,
      errors: [error],
    });
    // Never the try's to correct: only what the agent submitted is.
    expect(run.record).toEqual({
      try: 1,
      validationTry: 1,
      validationFailed: false,
      prompt: expect.objectContaining({ path: '01-spec/call-1/prompt.md' }),
      harness: recorded,
      usage,
    });
  }
});

const TOKENS = { input: 60, cacheRead: 0, cacheWrite: 0, output: 12 };
const WORKING: HarnessEvent[] = [
  { type: 'harness:session_start', adapter: 'scripted', sessionId: 'session-7', model: MODEL },
  { type: 'tool:start', callId: 'tool-1', tool: 'Read', input: { path: 'docs/brief.md' } },
  { type: 'tool:end', callId: 'tool-1', status: 'completed', durationMs: 4 },
  { type: 'usage:update', turn: 1, tokens: TOKENS, costUsdSoFar: 0.0625 },
  { type: 'tool:start', callId: 'tool-2', tool: 'Bash', input: { command: 'git push' } },
  { type: 'permission:denied', callId: 'tool-2', tool: 'Bash', rule: 'commands', permissions, reason: 'not allowed' },
  { type: 'tool:end', callId: 'tool-2', status: 'denied', durationMs: 0 },
  { type: 'agent:message', text: 'Spec written.' },
  { type: 'usage:update', turn: 2, tokens: { ...TOKENS, input: 90 }, costUsdSoFar: 0.09375 },
];

test('every session ends exactly once, after its other events, with the usage the harness returned and the turns, tool calls and denials seen on the way', async () => {
  const counted = { sessionId: 'session-7', outcome: 'done', turns: 2, toolCalls: 2, denials: 1, usage: USAGE };
  const end = { type: 'harness:session_end' as const, outcome: 'done' as const, turns: 2, toolCalls: 2, denials: 1 };
  const files = { 'spec.md': '# Spec\n' };

  // A harness that reports its work and never its end: the counters are the ones seen.
  const endless = await tried(spec(), scripted({ resolves: done(VALID), emits: WORKING, files }));
  expect(types(endless.s.events)).toEqual([
    'prompt:rendered',
    ...WORKING.map((event) => event.type),
    'harness:session_end',
    'output:validated',
    'file:produced',
  ]);
  expect(endless.s.events.slice(1, 1 + WORKING.length)).toEqual(WORKING);
  expect(ends(endless.s.events)).toEqual([{ type: 'harness:session_end', ...counted }]);
  expect(endless.run.record).toMatchObject({
    harness: { adapter: 'scripted', model: MODEL, sessionId: 'session-7', turns: 2, toolCalls: 2, denials: 1 },
    usage: USAGE,
  });

  // A harness that ends its session twice, the first time mid-way and with less than it returns: one end, at the end.
  const early = { ...end, sessionId: 'session-7', usage: { costUsd: 0.0625 } };
  const twice = [...WORKING.slice(0, 4), early, ...WORKING.slice(4), { ...end, sessionId: 'session-7', usage: USAGE }];
  const doubled = await tried(spec(), scripted({ resolves: done(VALID), emits: twice, files }));
  expect(types(doubled.s.events)).toEqual(types(endless.s.events));
  expect(ends(doubled.s.events)).toEqual([{ type: 'harness:session_end', ...counted }]);

  // A harness that emits nothing still has its session ended, with what it returned, and no start is made up.
  const silent = await tried(spec(), scripted({ resolves: done(VALID), files }));
  expect(types(silent.s.events)).toEqual([
    'prompt:rendered',
    'harness:session_end',
    'output:validated',
    'file:produced',
  ]);
  expect(ends(silent.s.events)).toEqual([
    { type: 'harness:session_end', ...counted, turns: 0, toolCalls: 0, denials: 0 },
  ]);
});

test('a failed session reports error:harness once, before its end; a session out of turns reports its budget first, and its partial usage', async () => {
  const start = WORKING[0] as HarnessEvent;
  const message: HarnessEvent = { type: 'agent:message', text: 'Reading the brief.' };

  // The harness reported its own failure: it is not reported again.
  const reported = scripted({
    resolves: failed('model overloaded'),
    emits: [start, { type: 'error:harness', message: 'model overloaded' }],
  });
  const first = await tried(spec(), reported);
  expect(first.s.events.slice(1)).toEqual([
    start,
    { type: 'error:harness', message: 'model overloaded' },
    expect.objectContaining({ type: 'harness:session_end', sessionId: 'session-7', outcome: 'error', usage: USAGE }),
  ]);

  // A harness that rejects reported nothing of it, and returned nothing: the kind says so, and keeps what it heard.
  const second = await tried(spec(), scripted({ resolves: new Error('socket hang up'), emits: [message] }));
  expect(types(second.s.events)).toEqual(['prompt:rendered', 'agent:message', 'error:harness', 'harness:session_end']);
  expect(second.s.events.slice(1, 3)).toEqual([
    message,
    { type: 'error:harness', message: expect.stringContaining('socket hang up') },
  ]);
  expect(ends(second.s.events)).toEqual([
    { type: 'harness:session_end', outcome: 'error', turns: 0, toolCalls: 0, denials: 0, usage: { costUsd: 0 } },
  ]);
  expect(second.s.read('session.log')).toContain('Reading the brief.');

  // The fake, out of turns after the first of three.
  const usage = { costUsd: 0.75, outputTokens: 300 };
  const fake = createFakeHarness({ script: { spec: [{ outcome: 'done', output: VALID, turns: 3, usage }] } });
  const spent = { costUsd: 0.25, outputTokens: 100 };
  const third = await tried(spec({ budget: { ...budget, maxTurns: 1 } }), fake);
  expect(third.run.errors).toEqual([{ reason: 'budget_exceeded', message: 'budget exceeded: maxTurns 1' }]);
  expect(third.run.record).toMatchObject({
    validationFailed: false,
    harness: { adapter: 'fake', model: MODEL, sessionId: 'fake-session-spec-1', turns: 1, toolCalls: 0, denials: 0 },
    usage: spent,
  });
  expect(types(third.s.events)).toEqual([
    'prompt:rendered',
    'harness:session_start',
    'usage:update',
    'budget:exceeded',
    'error:harness',
    'harness:session_end',
  ]);
  expect(ends(third.s.events)).toEqual([
    {
      type: 'harness:session_end',
      sessionId: 'fake-session-spec-1',
      outcome: 'error',
      turns: 1,
      toolCalls: 0,
      denials: 0,
      usage: spent,
    },
  ]);
});

/** What is wrong with the result a call would write from `run`: nothing, when it is one. */
function resultIssues(run: StepRun): string[] {
  const at = new Date('2026-10-05T10:00:00.000Z');
  const consumed = { brief: 'docs/brief.md' };
  const result = buildResult({
    runId: RUN_ID,
    stage: 'spec',
    call: 1,
    kind: 'agent',
    run,
    consumed,
    startedAt: at,
    finishedAt: at,
  });
  return validateDocument('sail.result.v1', result).map(formatIssue);
}

test('a session whose harness rejects, or returns a usage the port refuses, is recorded with what it last said it had spent', async () => {
  // WORKING reports two turns, the second at $0.09375.
  const spent = { inputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 12, costUsd: 0.09375 };
  const hungUp = new Error('socket hang up');

  const rejected = await tried(spec(), scripted({ resolves: hungUp, emits: WORKING }));
  expect(rejected.run.errors).toEqual([{ reason: 'harness', message: expect.stringContaining('socket hang up') }]);
  expect(rejected.run.record).toMatchObject({ harness: { sessionId: 'session-7', turns: 2 }, usage: spent });
  expect(ends(rejected.s.events)).toEqual([
    {
      type: 'harness:session_end',
      sessionId: 'session-7',
      outcome: 'error',
      turns: 2,
      toolCalls: 2,
      denials: 1,
      usage: spent,
    },
  ]);
  expect(resultIssues(rejected.run)).toEqual([]);

  const refused = scripted({ resolves: { ...done(VALID), usage: { costUsd: -1 } }, emits: WORKING });
  expect((await tried(spec(), refused)).run.record.usage).toEqual(spent);

  // The session's own end is its last word on what it spent, and says more than the update before it.
  const end: HarnessEvent = {
    type: 'harness:session_end',
    sessionId: 'session-7',
    outcome: 'error',
    turns: 2,
    toolCalls: 2,
    denials: 1,
    usage: { costUsd: 0.125 },
  };
  const ended = await tried(spec(), scripted({ resolves: hungUp, emits: [...WORKING, end] }));
  expect(ended.run.record.usage).toEqual({ costUsd: 0.125 });

  // An update, or an end, that says no usage is not counted: the last that did stands.
  const garbled = [
    { type: 'usage:update', turn: 2, tokens: TOKENS, costUsdSoFar: -4 },
    { type: 'usage:update', turn: 2, costUsdSoFar: 9 },
    { type: 'usage:update', turn: 2, tokens: { ...TOKENS, output: 1.5 }, costUsdSoFar: 9 },
    { ...end, usage: { costUsd: Number.NaN } },
  ] as unknown as HarnessEvent[];
  const misreported = await tried(spec(), scripted({ resolves: hungUp, emits: [...WORKING, ...garbled] }));
  expect(misreported.run.record.usage).toEqual(spent);
  expect(resultIssues(misreported.run)).toEqual([]);
});
