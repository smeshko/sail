// The claude-code Harness over a scripted query(): the port suite, then the session's options and environment, its
// events, the guard's denials, aborts, and failures that never reject. No test here starts Claude Code.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeCodeHarness, type QueryFunction, sessionOptions } from '../../../src/adapters/claude-code/harness';
import { SUBMIT_CONTRACT, submissionEnvelope } from '../../../src/adapters/claude-code/submission';
import type { HarnessEvent, HarnessRequest } from '../../../src/ports/harness';
import type { HarnessResult } from '../../../src/ports/types';
import {
  assistantText,
  assistantToolUse,
  COST,
  done,
  init,
  resultError,
  resultSuccess,
  SESSION_ID,
  type Stream,
  scriptedQuery,
  toolResult,
} from '../../helpers/claude-code';
import { captureEvents, eventIssues } from '../../helpers/ports';
import { harnessSuite } from '../../ports/harness.suite';

const base = mkdtempSync(join(tmpdir(), 'sail-claude-code-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let made = 0;

/** A request for `spec#1`, prompted `prompt`, in a workspace and call directory of its own. */
function request(prompt = 'Write the spec.', extra: Partial<HarnessRequest> = {}): HarnessRequest {
  const dir = join(base, String(++made));
  const [cwd, stageIn, stageOut] = ['work', 'in', 'out'].map((name) => join(dir, name)) as [string, string, string];
  for (const path of [cwd, stageIn, stageOut]) mkdirSync(path, { recursive: true });
  return {
    key: 'spec#1',
    try: 1,
    prompt,
    cwd,
    env: { STAGE_IN: stageIn, STAGE_OUT: stageOut, TRY: '1' },
    model: 'claude-opus-5-5',
    permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
    budget: { maxTurns: 40, maxUsd: 2, maxMinutes: 10 },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
    ...extra,
  };
}

const SPEC = { summary: 'Add a flag.' };

/** A session that reads a file, says one thing and ends with `result`. */
const session = (result: SDKMessage): Stream => [
  init(),
  assistantToolUse('m1', 't1', 'Read', { file_path: 'brief.md' }, { usage: { input: 10, output: 20, cacheRead: 300 } }),
  toolResult('t1'),
  assistantText('m2', 'Spec written.', { usage: { input: 5, output: 40, cacheWrite: 60 } }),
  result,
];

const SUITE: Record<string, Stream> = {
  done: session(resultSuccess({ structured: done(SPEC) })),
  blocked: session(resultSuccess({ structured: { outcome: 'blocked', reason: 'No acceptance criteria.' } })),
  error: session(resultError('error_during_execution', { errors: ['overloaded'] })),
  overTurns: session(resultError('error_max_turns')),
};

/** A query that plays the suite's stream named by the session's prompt. */
const suiteQuery: QueryFunction = (params) => scriptedQuery([SUITE[params.prompt] ?? []])(params);

describe('the port suite', () =>
  harnessSuite('claude-code (scripted query)', async () => ({
    adapter: createClaudeCodeHarness({ env: {}, query: suiteQuery }),
    world: {
      done: request('done'),
      blocked: request('blocked'),
      error: request('error'),
      overTurns: request('overTurns'),
    },
  })));

/** A result as one value: a done result's output, or `<outcome>: <reason or message>`. */
function summary(result: HarnessResult): unknown {
  if (result.outcome === 'done') return result.output;
  return `${result.outcome}: ${result.outcome === 'blocked' ? result.reason : result.message}`;
}

/** Runs `stream` on a harness of its own, capturing the events. */
async function play(stream: Stream, extra: Partial<HarnessRequest> = {}, env: Record<string, string> = {}) {
  const query = scriptedQuery([stream]);
  let clock = 0;
  const harness = createClaudeCodeHarness({ env, query, now: () => (clock += 5) });
  const capture = captureEvents<HarnessEvent>();
  const result = await harness.run({ ...request(), onEvent: capture.emit, ...extra });
  return { query, result, capture, types: capture.events.map((event) => event.type) };
}

test("the session's options are the step's model, workspace, envelope and budgets, isolated from the user's settings", () => {
  const req = request();
  const options = sessionOptions(req, {});
  const { abortController, canUseTool, env: _env, ...rest } = options;
  expect(rest as Record<string, unknown>).toEqual({
    cwd: req.cwd,
    model: 'claude-opus-5-5',
    additionalDirectories: [req.env.STAGE_IN, req.env.STAGE_OUT],
    settingSources: [],
    // Review R1-3: an ask rule on every file tool comes before the CLI's own read and write allowances, so each call
    // reaches the guard.
    settings: { autoMemoryEnabled: false, permissions: { ask: ['Read', 'Glob', 'Grep', 'Write', 'Edit'] } },
    skills: [],
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
    includePartialMessages: false,
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
    permissionMode: 'default',
    outputFormat: { type: 'json_schema', schema: submissionEnvelope(req.outputSchema) },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SUBMIT_CONTRACT },
    maxTurns: 40,
    maxBudgetUsd: 2,
  });
  expect({
    controller: abortController instanceof AbortController && !abortController.signal.aborted,
    guard: typeof canUseTool,
    bypass: ['allowedTools', 'allowDangerouslySkipPermissions', 'disallowedTools'].filter((name) => name in options),
    mode: options.permissionMode === 'bypassPermissions',
  }).toEqual({ controller: true, guard: 'function', bypass: [], mode: false });
});

test("a session with no STAGE_IN gets only $STAGE_OUT as an extra directory, and a session's controller is its own", () => {
  const req = request();
  const { STAGE_IN: _in, ...env } = req.env;
  const one = sessionOptions({ ...req, env }, {});
  const two = sessionOptions(req, {});
  const seen: Record<string, unknown> = {
    dirs: one.additionalDirectories,
    own: one.abortController !== two.abortController,
  };
  expect(seen).toEqual({
    dirs: [req.env.STAGE_OUT],
    own: true,
  });
});

test("the session's environment is the allowlisted names of sail's, the client app, and the preamble, which wins a clash", () => {
  const plain = request();
  // The preamble names LANG too: it wins over sail's.
  const req: HarnessRequest = { ...plain, env: { ...plain.env, LANG: 'C.UTF-8' } };
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/sail',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    TERM: 'xterm',
    CLAUDE_CONFIG_DIR: '/cfg',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
    ANTHROPIC_BASE_URL: 'https://proxy',
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: 'eu-central-1',
    CLOUD_ML_REGION: 'europe-west4',
    GOOGLE_CLOUD_PROJECT: 'p',
    HTTPS_PROXY: 'http://proxy',
    SECRET_TOKEN: 'no',
    GITHUB_TOKEN: 'no',
    NODE_OPTIONS: '--inspect',
    STAGE_OUT: '/not/the/preamble',
    MISSING: undefined,
  };
  expect(sessionOptions(req, env).env).toEqual({
    PATH: '/usr/bin',
    HOME: '/home/sail',
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    TERM: 'xterm',
    CLAUDE_CONFIG_DIR: '/cfg',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
    ANTHROPIC_BASE_URL: 'https://proxy',
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: 'eu-central-1',
    CLOUD_ML_REGION: 'europe-west4',
    GOOGLE_CLOUD_PROJECT: 'p',
    HTTPS_PROXY: 'http://proxy',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'sail',
    STAGE_IN: req.env.STAGE_IN,
    STAGE_OUT: req.env.STAGE_OUT,
    TRY: '1',
  });
});

test('the session sees the OAuth token, and nothing the harness reports carries a credential', async () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-secret-key', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret-token' };
  expect(sessionOptions(request(), env).env).toMatchObject(env);
  const { result, capture } = await play(SUITE.done ?? [], {}, env);
  const reported = JSON.stringify([result, capture.events]);
  expect([reported.includes('secret-key'), reported.includes('secret-token')]).toEqual([false, false]);
});

test('a done session runs its prompt with those options, reports its usage at the total cost, and ends last with its counts', async () => {
  const { query, result, capture, types } = await play(SUITE.done ?? []);
  expect(query.calls.map((call) => call.prompt)).toEqual(['Write the spec.']);
  expect(types).toEqual([
    'harness:session_start',
    'tool:start',
    'usage:update',
    'tool:end',
    'agent:message',
    'usage:update',
    'usage:update',
    'harness:session_end',
  ]);
  const usage = { inputTokens: 120, cacheReadTokens: 5000, cacheWriteTokens: 800, outputTokens: 340, costUsd: COST };
  expect({ output: summary(result), sessionId: result.sessionId, usage: result.usage }).toEqual({
    output: SPEC,
    sessionId: SESSION_ID,
    usage,
  });
  const updates = capture.events.filter((event) => event.type === 'usage:update');
  expect(updates.at(-1)).toEqual({
    type: 'usage:update',
    turn: 2,
    tokens: { input: 120, cacheRead: 5000, cacheWrite: 800, output: 340 },
    costUsdSoFar: COST,
  });
  expect(capture.events.at(-1)).toEqual({
    type: 'harness:session_end',
    sessionId: SESSION_ID,
    outcome: 'done',
    reason: 'submitted',
    turns: 2,
    toolCalls: 1,
    denials: 0,
    usage,
  });
});

test('events reach onEvent as the session goes, not when it is over', async () => {
  const capture = captureEvents<HarnessEvent>();
  let heardBeforeSecond = -1;
  const query: QueryFunction = async function* () {
    yield init();
    heardBeforeSecond = capture.events.length;
    yield resultSuccess({ structured: done(SPEC) });
  };
  await createClaudeCodeHarness({ env: {}, query }).run({ ...request(), onEvent: capture.emit });
  expect(heardBeforeSecond).toBe(1);
});

test('a failed session emits error:harness once with its message, then its end with the outcome, end reason, counts and usage', async () => {
  const { result, capture, types } = await play(SUITE.overTurns ?? []);
  expect(summary(result)).toBe('error: budget exceeded: maxTurns 40');
  expect(types.filter((type) => type === 'error:harness')).toHaveLength(1);
  expect(capture.events.slice(-2)).toEqual([
    { type: 'error:harness', message: 'budget exceeded: maxTurns 40' },
    {
      type: 'harness:session_end',
      sessionId: SESSION_ID,
      outcome: 'error',
      reason: 'max_turns',
      turns: 2,
      toolCalls: 1,
      denials: 0,
      usage: result.usage,
    },
  ]);
  expect(eventIssues(capture.stamped('spec#1'))).toEqual([]);
});

test("a tool the guard denies ends denied, and the session's end counts the denial", async () => {
  const { query, result, capture } = await play([
    init(),
    assistantToolUse('m1', 't1', 'Bash', { command: 'cat ~/.ssh/id_rsa' }, { usage: { output: 5 } }),
    { act: 'useTool', tool: 'Bash', input: { command: 'cat ~/.ssh/id_rsa' }, toolUseID: 't1' },
    toolResult('t1', { isError: true }),
    resultSuccess({ structured: done(SPEC) }),
  ]);
  expect(query.verdicts).toEqual([
    {
      behavior: 'deny',
      message: 'the claude-code harness allows only file tools until permissions are enforced: Bash is not one',
    },
  ]);
  const end = capture.events.at(-1);
  expect({
    toolEnd: capture.events.find((event) => event.type === 'tool:end'),
    denials: end?.type === 'harness:session_end' ? end.denials : undefined,
    outcome: result.outcome,
  }).toEqual({
    toolEnd: { type: 'tool:end', callId: 't1', status: 'denied', durationMs: 5 },
    denials: 1,
    outcome: 'done',
  });
});

test('a request already aborted resolves as error aborted, and no session starts', async () => {
  const { query, result, types } = await play(SUITE.done ?? [], { signal: AbortSignal.abort() });
  expect({ result: summary(result), calls: query.calls.length, types }).toEqual({
    result: 'error: aborted',
    calls: 0,
    types: [],
  });
});

test("an abort during the session fires the session's controller, resolves as error aborted, and ends the session last", async () => {
  const controller = new AbortController();
  const query = scriptedQuery([[init(), { act: 'waitForAbort' }]]);
  const types: string[] = [];
  const result = await createClaudeCodeHarness({ env: {}, query }).run({
    ...request(),
    signal: controller.signal,
    onEvent: (event) => {
      types.push(event.type);
      if (event.type === 'harness:session_start') setTimeout(() => controller.abort(), 10);
    },
  });
  expect({
    result: summary(result),
    fired: query.calls[0]?.options.abortController?.signal.aborted,
    types,
  }).toEqual({
    result: 'error: aborted',
    fired: true,
    types: ['harness:session_start', 'error:harness', 'harness:session_end'],
  });
});

test('a query that throws, a stream that throws, and an onEvent that throws each resolve as error, never a rejection', async () => {
  const throwing: QueryFunction = () => {
    throw new Error('spawn claude ENOENT');
  };
  const thrown = await createClaudeCodeHarness({ env: {}, query: throwing }).run(request());
  const broken = await play([init(), { act: 'throw', message: 'stream closed' }]);
  let heard = 0;
  const deaf = await createClaudeCodeHarness({ env: {}, query: scriptedQuery([SUITE.done ?? []]) }).run({
    ...request(),
    onEvent: () => {
      heard++;
      throw new Error('not listening');
    },
  });
  expect({
    thrown: summary(thrown),
    broken: summary(broken.result),
    brokenTypes: broken.types,
    deaf: summary(deaf),
    heard,
  }).toEqual({
    thrown: 'error: claude-code: spawn claude ENOENT',
    broken: 'error: claude-code: stream closed',
    brokenTypes: ['harness:session_start', 'error:harness', 'harness:session_end'],
    deaf: 'error: claude-code: not listening',
    heard: 1,
  });
});

// Review R1-6: an onEvent that throws on the session's end fails the session as one that throws earlier does, and the
// result keeps what it spent.
test('an onEvent that throws only on the session end turns a done session into error, keeping its usage', async () => {
  let heard = 0;
  const result = await createClaudeCodeHarness({ env: {}, query: scriptedQuery([SUITE.done ?? []]) }).run({
    ...request(),
    onEvent: (event) => {
      heard++;
      if (event.type === 'harness:session_end') throw new Error('journal full');
    },
  });
  const failed = await createClaudeCodeHarness({ env: {}, query: scriptedQuery([SUITE.error ?? []]) }).run({
    ...request(),
    onEvent: (event) => {
      if (event.type === 'harness:session_end') throw new Error('journal full');
    },
  });
  expect({
    result: summary(result),
    cost: result.usage.costUsd,
    sessionId: result.sessionId,
    ended: result.transcript.split('\n').at(-1),
    heard,
    failed: summary(failed),
  }).toEqual({
    result: 'error: claude-code: journal full',
    cost: COST,
    sessionId: SESSION_ID,
    ended: 'ended: error: claude-code: journal full',
    heard: 8,
    failed: 'error: the session failed during execution: overloaded',
  });
});

// Review R1-7: a throw outside the session's stream, building its options or reading its end, resolves as error too.
test('options that cannot be built, and a result that cannot be read, resolve as error, never a rejection', async () => {
  const req = request();
  const unbuildable = await createClaudeCodeHarness({ env: {}, query: scriptedQuery([SUITE.done ?? []]) }).run({
    ...req,
    env: new Proxy(req.env, {
      get: () => {
        throw new Error('no environment');
      },
    }),
  });
  const unreadable = resultSuccess({ structured: done(SPEC) });
  const { result, types } = await play(session({ ...unreadable, modelUsage: undefined } as unknown as SDKMessage));
  expect({
    unbuildable: summary(unbuildable),
    unbuildableUsage: unbuildable.usage,
    result: String(summary(result)).startsWith('error: claude-code: '),
    types,
    transcript: result.transcript.split('\n').at(-1)?.startsWith('ended: error: claude-code: '),
  }).toEqual({
    unbuildable: 'error: claude-code: no environment',
    unbuildableUsage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 },
    result: true,
    types: [
      'harness:session_start',
      'tool:start',
      'usage:update',
      'tool:end',
      'agent:message',
      'error:harness',
      'harness:session_end',
    ],
    transcript: true,
  });
});

test("the transcript renders the session's events and how it ended", async () => {
  const { result } = await play(SUITE.done ?? []);
  expect(result.transcript).toBe(
    [
      `session ${SESSION_ID} on claude-sonnet-5`,
      'tool Read {"file_path":"brief.md"} [t1]',
      'usage: turn 1, in 10, cache read 300, cache write 0, out 20, $0',
      'tool t1 completed in 5 ms',
      'assistant: Spec written.',
      'usage: turn 2, in 15, cache read 300, cache write 60, out 60, $0',
      `usage: turn 2, in 120, cache read 5000, cache write 800, out 340, $${COST}`,
      'ended: done',
    ].join('\n'),
  );
});

test('claude-code declares structured output, permissions, usage, abort, and turn and dollar budgets', () => {
  expect(createClaudeCodeHarness({ env: {} }).capabilities()).toEqual({
    structuredOutput: true,
    permissions: true,
    usage: true,
    abort: true,
    budgets: ['turns', 'usd'],
  });
  expect(createClaudeCodeHarness({ env: {} }).name).toBe('claude-code');
});
