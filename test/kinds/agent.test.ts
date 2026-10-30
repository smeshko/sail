// The agent kind: one try of an agent step. A scripted harness stands in for the port, so each test says what the
// session reports and returns, and reads back what the try sent it, emitted, recorded and left in its call directory.
import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFakeHarness } from '../../src/adapters/fake/harness';
import { FEEDBACK_SOURCE } from '../../src/engine/agent-prompt';
import { materialisePrepared, type PreparedBindings, prepareBindings, type Supplied } from '../../src/engine/bindings';
import { type CallPaths, callPaths, createCallDir, stepPaths } from '../../src/engine/call-dir';
import type { ContractError } from '../../src/engine/contract';
import { redactor } from '../../src/engine/redact';
import { buildResult } from '../../src/engine/result';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import type { CallEvent } from '../../src/events/types';
import { agentKind } from '../../src/kinds/agent';
import type { AgentTry, StepContext, StepRun } from '../../src/kinds/index';
import type { Harness, HarnessEvent, HarnessRequest } from '../../src/ports/harness';
import type { HarnessResult } from '../../src/ports/types';
import {
  type AgentStep,
  agent,
  countItems,
  doc,
  file,
  hasSections,
  noPlaceholders,
  untrusted,
  value,
  z,
} from '../../src/sdk/index';
import { type Recorded, recording, scripted, throwing } from '../helpers/scripted-harness';

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

type Options = Partial<
  Pick<AgentStep, 'consumes' | 'produces' | 'output' | 'budget' | 'onInvalidOutput' | 'conventions'>
>;

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

test('agent transcripts mask the run credential', async () => {
  const marker = 'ghp_AGENT_MARKER_0123456789';
  const step = bare(z.string());
  const s = setup(step);
  const harness = scripted({ resolves: { ...done('ok'), transcript: `echo ${marker}` } });
  await agentKind.run(step, { ...s.context(harness), redact: redactor([marker]) });
  expect(s.read('session.log')).toBe('echo [redacted]\n');
});

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
 * `.sail-runs/`, with `step`'s bindings materialised: a brief, when it consumes one, and whatever `more` supplies.
 */
function setup(
  step: AgentStep,
  template = 'Write the spec.\n',
  tryNumber = 1,
  more: Record<string, Supplied> = {},
): Setup {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'sail-agent-')));
  dirs.push(workspace);
  const stageDir = join(workspace, '.sail', 'stages', 'spec');
  write(join(stageDir, 'prompt.md'), template);
  const brief = write(join(workspace, 'docs', 'brief.md'), '# Brief\n');
  const supplied: Record<string, Supplied> = {
    ...('brief' in step.consumes ? { brief: { kind: 'file', path: brief, from: 'docs/brief.md' } } : {}),
    ...more,
  };
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
      root: workspace,
      branch: 'sail/FAKE-1',
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

test('a silent session stalls once and leaves no timer after returning', async () => {
  const step = bare(z.any());
  const limited = { ...step, budget: { ...budget, maxIdleMinutes: 0.001 } };
  const harness: Harness = {
    ...scripted({ resolves: done(null) }),
    async run() {
      await Bun.sleep(180);
      return done(null);
    },
  };
  const { s } = await tried(limited, harness);
  expect(s.events.filter((e) => e.type === 'step:stalled')).toEqual([
    { type: 'step:stalled', idleMs: 60, since: expect.any(String) },
  ]);
  const count = s.events.length;
  await Bun.sleep(100);
  expect(s.events.length).toBe(count);
});

test("a stall's since is the run's clock, as every event's ts is (review R3)", async () => {
  const step = { ...bare(z.any()), budget: { ...budget, maxIdleMinutes: 0.001 } };
  const s = setup(step);
  const harness: Harness = {
    ...scripted({ resolves: done(null) }),
    async run() {
      await Bun.sleep(120);
      return done(null);
    },
  };
  const clock = () => new Date('2026-09-27T09:00:00.000Z');
  await agentKind.run(step, { ...s.context(harness), clock });
  expect(s.events.filter((e) => e.type === 'step:stalled')).toEqual([
    { type: 'step:stalled', idleMs: 60, since: '2026-09-27T08:59:59.940Z' },
  ]);
});

test('an idle limit longer than a timer can wait does not stall a session at once (review R6)', async () => {
  const step = { ...bare(z.any()), budget: { ...budget, maxIdleMinutes: 1_000_000 } };
  const { s } = await tried(step, {
    ...scripted({ resolves: done(null) }),
    async run(req) {
      req.onEvent?.({ type: 'agent:message', text: 'working' });
      await Bun.sleep(50);
      return done(null);
    },
  });
  expect(s.events.filter((e) => e.type === 'step:stalled')).toEqual([]);
});

test('the default idle limit is a quarter of the own minute budget', async () => {
  const step = { ...bare(z.any()), budget: { ...budget, maxMinutes: 0.02 } };
  const { s } = await tried(step, {
    ...scripted({ resolves: done(null) }),
    async run() {
      await Bun.sleep(70);
      return done(null);
    },
  });
  expect(s.events.filter((e) => e.type === 'step:stalled')).toEqual([]);
});

test('a silence past a quarter of the own minute budget, short of half, stalls once at that quarter (review R8)', async () => {
  // 1.2 s of minutes: a quarter is 300 ms, half 600 ms.
  const step = { ...bare(z.any()), budget: { ...budget, maxMinutes: 0.02 } };
  const { s } = await tried(step, {
    ...scripted({ resolves: done(null) }),
    async run() {
      await Bun.sleep(450);
      return done(null);
    },
  });
  expect(s.events.filter((e) => e.type === 'step:stalled')).toEqual([
    { type: 'step:stalled', idleMs: 300, since: expect.any(String) },
  ]);
});

test('every event resets silence and a speaking stalled session can stall again', async () => {
  const step = { ...bare(z.any()), budget: { ...budget, maxIdleMinutes: 0.002 } };
  const s = setup(step);
  const harness: Harness = {
    ...scripted({ resolves: done(null) }),
    async run(req) {
      await Bun.sleep(70);
      req.onEvent?.({ type: 'agent:message', text: 'working' });
      await Bun.sleep(70);
      expect(s.events.filter((e) => e.type === 'step:stalled')).toEqual([]);
      await Bun.sleep(140);
      expect(s.events.filter((e) => e.type === 'step:stalled')).toHaveLength(1);
      req.onEvent?.({ type: 'agent:thinking', text: 'again' });
      await Bun.sleep(170);
      return done(null);
    },
  };
  await agentKind.run(step, s.context(harness));
  expect(s.events.filter((e) => e.type === 'step:stalled').map((e) => e.idleMs)).toEqual([120, 120]);
});

test('non-positive and non-finite idle limits are step problems', () => {
  for (const maxIdleMinutes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(agentKind.problems({ ...bare(z.any()), budget: { ...budget, maxIdleMinutes } })).toEqual([
      `budget.maxIdleMinutes must be a positive number: ${maxIdleMinutes}`,
    ]);
  }
});

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

test("problems() refuses a produced name that differs from an engine file's only by case", () => {
  expect(agentKind.problems(spec({ produces: { 'Prompt.md': 'file' } }))).toEqual([
    "'Prompt.md' can't be produced: the engine writes 'prompt.md' in $STAGE_OUT, and a file system that ignores case takes them for one",
  ]);
});

test('problems() refuses two produced names that differ only by case', () => {
  expect(agentKind.problems(spec({ produces: { 'Notes.md': 'file', 'notes.md': 'file' } }))).toEqual([
    "'notes.md' can't be produced: 'Notes.md' is produced too, and a file system that ignores case takes them for one",
  ]);
});

test('problems() reports a produced name the engine writes, a budget out of range, an unknown onInvalidOutput and an output JSON Schema cannot hold', () => {
  expect(agentKind.kind).toBe('agent');
  expect(agentKind.problems(spec())).toEqual([]);
  expect(agentKind.problems(spec({ budget: { ...budget, maxUsd: 1 }, onInvalidOutput: 'fail' }))).toEqual([]);
  expect(agentKind.problems(spec({ budget: { ...budget, maxUsd: 0 } }))).toEqual([
    'budget.maxUsd must be a positive number: 0',
  ]);
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
    ['maxUsd', 0],
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
      BRANCH: 'sail/FAKE-1',
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
  expect(prompt?.trimEnd()).toEndWith(`${feedback[0]}\n</untrusted-input>`);
  expect(prompt).toContain(`<untrusted-input source="${FEEDBACK_SOURCE}">\n${feedback[0]}\n</untrusted-input>`);
  expect(s.read('prompt.md')).toBe(prompt ?? '');
  expect(run.output).toEqual({ ...VALID, points: 2, approved: true });
  expect(run.record).toMatchObject({ try: 3, validationTry: 2, validationFailed: false });
});

test("problems() reports a step's conventions that aren't a list of distinct, non-empty paths relative to the repository", () => {
  expect(agentKind.problems(spec({ conventions: [] }))).toEqual([]);
  expect(agentKind.problems(spec({ conventions: ['CONTEXT.md', 'docs/STYLE.md'] }))).toEqual([]);
  expect(agentKind.problems(spec({ conventions: ['CONTEXT.md', ''] }))).toEqual([
    "conventions must be paths inside the repository: '' is empty",
  ]);
  expect(agentKind.problems(spec({ conventions: ['/etc/hosts'] }))).toEqual([
    "conventions must be paths inside the repository: '/etc/hosts' is absolute",
  ]);
  expect(agentKind.problems(spec({ conventions: ['CONTEXT.md', 'CONTEXT.md'] }))).toEqual([
    "conventions names 'CONTEXT.md' twice",
  ]);
  expect(agentKind.problems(spec({ conventions: 'CONTEXT.md' as never }))).toEqual([
    'conventions must be a list of paths: CONTEXT.md',
  ]);
});

test("a step's own conventions replace the project's in its prompt, in its own order, and an empty list appends none", async () => {
  const project = { conventions: ['AGENTS.md', 'CONTEXT.md'] };
  const prepared = (conventions?: readonly string[]) => {
    const step = spec(conventions === undefined ? {} : { conventions });
    const s = setup(step);
    write(join(s.workspace, 'AGENTS.md'), 'Indent with tabs.\n');
    write(join(s.workspace, 'CONTEXT.md'), '**Run**: one ticket through a workflow.\n');
    return { step, s, harness: scripted({ resolves: done(VALID), files: { 'spec.md': '# Spec\n' } }) };
  };
  const conventionsOf = (events: readonly CallEvent[]) =>
    events.flatMap((event) => (event.type === 'prompt:rendered' ? [event.conventions] : []));

  const inherited = prepared();
  await agentKind.run(inherited.step, inherited.s.context(inherited.harness, project));
  expect(conventionsOf(inherited.s.events)).toEqual([['AGENTS.md', 'CONTEXT.md']]);

  const narrowed = prepared(['CONTEXT.md']);
  await agentKind.run(narrowed.step, narrowed.s.context(narrowed.harness, project));
  expect(conventionsOf(narrowed.s.events)).toEqual([['CONTEXT.md']]);
  expect(narrowed.harness.requests[0]?.prompt).toContain('## Repository conventions: CONTEXT.md');
  expect(narrowed.harness.requests[0]?.prompt).not.toContain('Indent with tabs.');

  // A step may name a file the project's list doesn't: each is read as a path inside the repository either way.
  const reordered = prepared(['CONTEXT.md', 'AGENTS.md']);
  await agentKind.run(reordered.step, reordered.s.context(reordered.harness, { conventions: [] }));
  expect(conventionsOf(reordered.s.events)).toEqual([['CONTEXT.md', 'AGENTS.md']]);

  const none = prepared([]);
  await agentKind.run(none.step, none.s.context(none.harness, project));
  expect(conventionsOf(none.s.events)).toEqual([[]]);
  expect(none.harness.requests[0]?.prompt).not.toContain('## Repository conventions');
  expect(none.s.read('prompt.md')).not.toContain('Indent with tabs.');
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

test("a session that hit the usage limit ends the call in error with reason usage_limit and resetsAt, valid against the result's schema", async () => {
  const resetsAt = '2026-10-28T14:20:00.000Z';
  const message = "You've hit your session limit · resets 4:20pm (Europe/Sofia)";
  const { run } = await tried(spec(), scripted({ resolves: failed(message, { reason: 'usage_limit', resetsAt }) }));
  expect(run.outcome).toBe('error');
  expect(run.errors).toEqual([{ reason: 'usage_limit', message, resetsAt }]);
  expect(resultIssues(run)).toEqual([]);
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

test("what a harness's events say of its session is recorded only where it is a count or an id, so the try's result is always one its call can write", async () => {
  const files = { 'spec.md': '# Spec\n' };
  const seen = { adapter: 'scripted', model: MODEL, sessionId: 'session-7', turns: 2, toolCalls: 2, denials: 1 };
  const end = { type: 'harness:session_end', sessionId: 'session-7', outcome: 'done', usage: USAGE };
  const ending = (said: object): HarnessEvent[] => [...WORKING, { ...end, ...said } as unknown as HarnessEvent];

  // An end whose counts are no counts, and whose reason is no word: the try keeps what it counted itself.
  const miscounted = ending({ turns: -1, toolCalls: 1.5, denials: 'none', reason: 7 });
  const first = await tried(spec(), scripted({ resolves: done(VALID), emits: miscounted, files }));
  expect([first.run.outcome, first.run.record.harness]).toEqual(['done', seen]);
  expect(resultIssues(first.run)).toEqual([]);
  expect(first.s.events.filter((event) => event.type === 'harness:session_end')).toEqual([
    {
      type: 'harness:session_end',
      sessionId: 'session-7',
      outcome: 'done',
      turns: 2,
      toolCalls: 2,
      denials: 1,
      usage: USAGE,
    },
  ]);

  // Each count stands or falls on its own, and a reason that is a word is kept.
  const mixed = ending({ turns: 5, toolCalls: Number.NaN, denials: 0, reason: 'submitted' });
  const second = await tried(spec(), scripted({ resolves: done(VALID), emits: mixed, files }));
  expect(second.run.record.harness).toEqual({ ...seen, turns: 5, denials: 0 });
  expect(second.s.events.at(-3)).toMatchObject({ type: 'harness:session_end', reason: 'submitted', turns: 5 });

  // A start that names no session, and updates whose turn is no count, say nothing of the session.
  const garbled = [
    { type: 'harness:session_start', adapter: 'scripted', sessionId: 7, model: MODEL },
    { type: 'usage:update', turn: 1.5, tokens: TOKENS, costUsdSoFar: 0.0625 },
    { type: 'usage:update', turn: -3, tokens: TOKENS, costUsdSoFar: 0.0625 },
    { type: 'usage:update', turn: 'two', tokens: TOKENS, costUsdSoFar: 0.0625 },
  ] as unknown as HarnessEvent[];
  const third = await tried(spec(), scripted({ resolves: new Error('socket hang up'), emits: garbled }));
  expect(third.run.record.harness).toEqual(UNSTARTED);
  expect(resultIssues(third.run)).toEqual([]);
});

// Documents: each try's session starts from the templates, rendered with its bindings, and what it leaves is validated.

const Ticket = z.object({ key: z.string(), title: untrusted() });
const TICKET = { key: 'FAKE-1', title: 'Add a --shout flag' };
const ticketBound: Record<string, Supplied> = { ticket: { kind: 'value', value: TICKET, from: 'workflow' } };
const TEMPLATE = `# Spec for {{ticket.key}}

{{ticket.title}}

## Requirements

{{requirements: one bullet per acceptance criterion}}

## Tasks

{{tasks: one item per task}}
`;
/** TEMPLATE as the try renders it for TICKET. */
const RENDERED = `# Spec for FAKE-1

<untrusted-input source="ticket.title">
Add a --shout flag
</untrusted-input>

## Requirements

{{requirements: one bullet per acceptance criterion}}

## Tasks

{{tasks: one item per task}}
`;
const COMPLETED =
  '# Spec for FAKE-1\n\n## Requirements\n\n- greet --shout shouts\n\n## Tasks\n\n1. Add the flag\n2. Test it\n';
const CHECKS = ['hasSections(Requirements, Tasks)', 'noPlaceholders', 'countItems(Tasks, min 1)'];
const specDoc = (template = './templates/spec.md') =>
  doc(template, [hasSections('Requirements', 'Tasks'), noPlaceholders(), countItems('Tasks', { min: 1, as: 'tasks' })]);

/** The `spec` step with `spec.md` as a document, binding the ticket as well as the brief. */
const documented = (options: Options = {}): AgentStep =>
  spec({
    consumes: { brief: file('brief.md'), ticket: value(Ticket) },
    produces: { 'spec.md': specDoc() },
    ...options,
  });

/** A setup of `step` whose stage holds TEMPLATE as `templates/spec.md`, for try `tryNumber`. */
function documentSetup(step: AgentStep, tryNumber = 1): Setup {
  const s = setup(step, 'Write the spec.\n', tryNumber, 'ticket' in step.consumes ? ticketBound : {});
  write(join(s.workspace, '.sail', 'stages', 'spec', 'templates', 'spec.md'), TEMPLATE);
  return s;
}

/** `harness`, noting what `spec.md` in each session's `$STAGE_OUT` holds as the session starts, or null if nothing. */
function noting(harness: Harness): { harness: Harness; seen: (string | null)[] } {
  const seen: (string | null)[] = [];
  const before = (request: HarnessRequest) => {
    const path = join(request.env.STAGE_OUT ?? '', 'spec.md');
    seen.push(existsSync(path) ? readFileSync(path, 'utf8') : null);
  };
  return { harness: recording(harness, { before }), seen };
}

test("a document's template is in $STAGE_OUT when its session starts, rendered with the try's bindings: a value filled, an untrusted one wrapped, and every placeholder as written", async () => {
  const step = documented();
  const s = documentSetup(step);
  const { harness, seen } = noting(scripted({ resolves: done(VALID), files: { 'spec.md': COMPLETED } }));
  await agentKind.run(step, s.context(harness));
  expect(seen).toEqual([RENDERED]);
});

test('a later try starts from the template rendered afresh in its own directory, not from what an earlier try left', async () => {
  const step = documented();
  const s = documentSetup(step, 2);
  const first = join(dirname(s.paths.dir), 'spec.md');
  writeFileSync(first, '# Draft\n');
  const { harness, seen } = noting(scripted({ resolves: done(VALID), files: { 'spec.md': COMPLETED } }));
  await agentKind.run(step, s.context(harness, { validationTry: 2, feedback: ['spec.md: noPlaceholders: …'] }));
  expect(seen).toEqual([RENDERED]);
  expect(readFileSync(first, 'utf8')).toBe('# Draft\n');
});

test('a template that is missing, or names an unknown variable, ends the try as not_started before any session: no prompt, no events, an empty session.log and no usage', async () => {
  const unknown = '# Spec for {{ticket.keey}}\n';
  const cases: [AgentStep, string][] = [
    [
      documented({ produces: { 'spec.md': specDoc('./templates/missing.md') } }),
      "'spec.md': template ./templates/missing.md can't be read (ENOENT)",
    ],
    [
      documented({ produces: { 'spec.md': specDoc('./unknown.md') } }),
      "'spec.md': template ./unknown.md: line 1: unknown path `ticket.keey`",
    ],
  ];
  for (const [step, message] of cases) {
    const s = documentSetup(step);
    write(join(s.workspace, '.sail', 'stages', 'spec', 'unknown.md'), unknown);
    const harness = scripted({ resolves: done(VALID), files: { 'spec.md': COMPLETED } });
    const run = await agentKind.run(step, s.context(harness));
    expect(run).toEqual({
      outcome: 'error',
      output: null,
      files: {},
      errors: [{ reason: 'not_started', message }],
      record: { try: 1, validationTry: 1, validationFailed: false, harness: UNSTARTED, usage: { costUsd: 0 } },
    });
    expect([harness.requests, s.events, s.read('session.log'), s.read('prompt.md')]).toEqual([[], [], '', null]);
  }
});

test("problems() reports a derived key two of a step's documents share, naming both, and a produces value that is neither 'file' nor a document", () => {
  expect(agentKind.problems(documented())).toEqual([]);
  const step = spec({
    produces: {
      'spec.md': specDoc(),
      'plan.md': doc('./templates/plan.md', [countItems('Tasks', { as: 'tasks' })]),
      'notes.md': { kind: 'notes' } as never,
    },
  });
  expect(agentKind.problems(step)).toEqual([
    "derived key 'tasks' comes from both 'spec.md' (countItems(Tasks, min 1)) and 'plan.md' (countItems(Tasks))",
    "'notes.md' is neither 'file' nor a document",
  ]);
});

test('a valid document is reported produced and then valid, and the result records its checks on the file and the facts in derived, as sail.result.v1 holds them', async () => {
  const step = documented();
  const s = documentSetup(step);
  const run = await agentKind.run(
    step,
    s.context(scripted({ resolves: done(VALID), files: { 'spec.md': COMPLETED } })),
  );
  const entry = { path: '01-spec/call-1/spec.md', bytes: Buffer.byteLength(COMPLETED), sha256: sha256(COMPLETED) };
  expect([run.outcome, run.errors, run.files]).toEqual([
    'done',
    [],
    { 'spec.md': { ...entry, validation: { ok: true, checks: CHECKS } } },
  ]);
  expect(run.record).toMatchObject({ validationFailed: false, derived: { tasks: 2 } });
  expect(s.events.slice(-3)).toEqual([
    { type: 'output:validated' },
    { type: 'file:produced', name: 'spec.md', ...entry },
    { type: 'file:validated', name: 'spec.md', ok: true, checks: CHECKS },
  ]);
  expect(resultIssues(run)).toEqual([]);
});

test('a document with a placeholder left, or a required section missing, ends the try in error with an invalid_output per problem naming the file and check, beside any output problem, and still records the facts derived', async () => {
  const step = documented();
  // The session leaves the template as it was.
  const left = documentSetup(step);
  const unfilled = await agentKind.run(step, left.context(scripted({ resolves: done(VALID) })));
  expect([unfilled.outcome, unfilled.errors]).toEqual([
    'error',
    [
      'spec.md: noPlaceholders: line 9 still holds the placeholder {{requirements: …}}',
      'spec.md: noPlaceholders: line 13 still holds the placeholder {{tasks: …}}',
      "spec.md: countItems(Tasks, min 1): 'Tasks' has 0 items, fewer than 1",
    ].map((message) => ({ reason: 'invalid_output', message })),
  ]);
  expect(unfilled.record).toMatchObject({ validationFailed: true, derived: { tasks: 0 } });
  expect(unfilled.files['spec.md']?.validation).toEqual({ ok: false, checks: CHECKS });
  expect(left.events.at(-1)).toEqual({ type: 'file:validated', name: 'spec.md', ok: false, checks: CHECKS });
  expect(resultIssues(unfilled)).toEqual([]);

  // The session drops a section and submits an output its schema refuses: both are reported, the output's first.
  const dropped = documentSetup(step);
  const harness = scripted({
    resolves: done({ summary: 3, tasks: ['x'] }),
    files: { 'spec.md': COMPLETED.replace('## Requirements\n\n- greet --shout shouts\n\n', '') },
  });
  const both = await agentKind.run(step, dropped.context(harness));
  expect(both.errors).toEqual([
    { reason: 'invalid_output', message: expect.stringContaining('expected string, received number') },
    { reason: 'invalid_output', message: "spec.md: hasSections(Requirements, Tasks): has no 'Requirements' section" },
  ]);
  expect(both.record).toMatchObject({ validationFailed: true, derived: { tasks: 2 } });
});

test('corrective prompt names only template placeholders, not quoted color tags', async () => {
  const step = documented();
  const s = documentSetup(step);
  const answer = COMPLETED.replace('- greet --shout shouts', '{{requirements: left}}\nstyle={{color: red}}');
  const first = await agentKind.run(step, s.context(scripted({ resolves: done(VALID), files: { 'spec.md': answer } })));
  expect(first.errors).toEqual([
    {
      reason: 'invalid_output',
      message: 'spec.md: noPlaceholders: line 5 still holds the placeholder {{requirements: …}}',
    },
  ]);
  const later = documentSetup(step, 2);
  const harness = scripted({ resolves: done(VALID), files: { 'spec.md': COMPLETED } });
  const run = await agentKind.run(
    step,
    later.context(harness, { validationTry: 2, feedback: first.errors.map(({ message }) => message) }),
  );
  expect(run.outcome).toBe('done');
  expect(harness.requests[0]?.prompt).toContain(
    'spec.md: noPlaceholders: line 5 still holds the placeholder {{requirements: …}}',
  );
  expect(harness.requests[0]?.prompt.includes('color')).toBe(false);
  expect(harness.requests[0]?.prompt).toContain(
    `<untrusted-input source="${FEEDBACK_SOURCE}">\nspec.md: noPlaceholders: line 5 still holds the placeholder {{requirements: …}}\n</untrusted-input>`,
  );
});

test('only a document the session left is validated: one it removed is a missing file, with no verdict', async () => {
  const step = documented({
    produces: { 'spec.md': specDoc(), 'plan.md': doc('./templates/spec.md', [noPlaceholders()]) },
  });
  const s = documentSetup(step);
  const removing = recording(scripted({ resolves: done(VALID), files: { 'spec.md': COMPLETED } }), {
    after: (request) => rmSync(join(request.env.STAGE_OUT ?? '', 'plan.md'), { force: true }),
  });
  const run = await agentKind.run(step, s.context(removing));
  expect(run.errors).toEqual([{ reason: 'missing_file', message: "'plan.md' was not produced in $STAGE_OUT" }]);
  expect(Object.keys(run.files)).toEqual(['spec.md']);
  expect(s.events.filter((event) => event.type.startsWith('file:')).map((event) => event.type)).toEqual([
    'file:produced',
    'file:validated',
  ]);
});

test("a step of a multi-step call renders and records its document in its call's $STAGE_OUT, keeps its prompt and transcript beside its own $STAGE_IN, and asks under the step's key", async () => {
  const step = documented();
  const s = documentSetup(step);
  const runDir = dirname(dirname(s.paths.dir));
  const paths = stepPaths(runDir, 5, 'publish', 1, 1, 'describe');
  createCallDir(paths);
  const { harness, seen } = noting(scripted({ resolves: done(VALID), files: { 'spec.md': COMPLETED } }));
  const base = s.context(harness);
  const { inputs } = materialisePrepared(base.agent?.bindings as PreparedBindings, paths.stageIn);
  const run = await agentKind.run(step, { ...base, stage: 'publish', key: 'publish#1/describe', paths, inputs });

  const call = join(runDir, '05-publish', 'call-1');
  const [request] = (harness as Recorded).requests;
  expect([request?.key, request?.env.STAGE_OUT, request?.env.STAGE_IN]).toEqual([
    'publish#1/describe',
    call,
    join(call, 'steps', '1-describe', 'in'),
  ]);
  expect(seen).toEqual([RENDERED]);
  expect([run.outcome, run.files['spec.md']?.path, run.record.prompt]).toEqual([
    'done',
    '05-publish/call-1/spec.md',
    expect.objectContaining({ path: '05-publish/call-1/steps/1-describe/prompt.md' }),
  ]);
  expect([readdirSync(call).sort(), readdirSync(paths.dir).sort()]).toEqual([
    ['spec.md', 'steps'],
    ['in', 'prompt.md', 'session.log'],
  ]);
});
