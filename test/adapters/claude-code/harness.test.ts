// The claude-code Harness over a scripted query(): the port suite, then the session's options and environment, its
// events, the gate's denials, the three budgets, the process group, aborts, and failures that never reject. No test here
// starts Claude Code: the processes some cases spawn stand in for it.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createClaudeCodeHarness,
  INTERRUPT_GRACE_MS,
  type QueryFunction,
  sessionOptions,
} from '../../../src/adapters/claude-code/harness';
import { SUBMIT_CONTRACT, submissionEnvelope } from '../../../src/adapters/claude-code/submission';
import { BUILTIN_TOOLS } from '../../../src/adapters/claude-code/tool-call';
import { decide } from '../../../src/engine/permissions';
import type { HarnessEvent, HarnessRequest } from '../../../src/ports/harness';
import { HarnessCapabilities, type HarnessResult } from '../../../src/ports/types';
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
import { fakeTimers } from '../../helpers/fake-timers';
import { captureEvents, eventIssues, parseIssues } from '../../helpers/ports';
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

const OVER_TURNS = 'Reached maximum number of turns (40)';

const SUITE: Record<string, Stream> = {
  done: session(resultSuccess({ structured: done(SPEC) })),
  blocked: session(resultSuccess({ structured: { outcome: 'blocked', reason: 'No acceptance criteria.' } })),
  error: session(resultError('error_during_execution', { errors: ['overloaded'] })),
  // Live run 1: after an error result the SDK throws, restating it, as the real session over its turns did.
  overTurns: [
    ...session(resultError('error_max_turns', { errors: [OVER_TURNS] })),
    { act: 'throw', message: `Claude Code returned an error result: ${OVER_TURNS}` },
  ],
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

/** What the session's system prompt gets appended for `req`: where it works, then the submit contract. */
const appended = (req: HarnessRequest) =>
  [
    '## Where you work',
    '',
    `Your working directory is the workspace, ${req.cwd}. You have no shell, so you can't read environment`,
    'variables: where a prompt names one of these, it means the value given.',
    '',
    ...Object.entries(req.env).map(([name, value]) => `- \`$${name}\`: ${value}`),
    '',
    'A file the step produces goes straight into `$STAGE_OUT` under its own name, as `$STAGE_OUT/<name>`, not into a',
    'directory below it.',
    '',
    SUBMIT_CONTRACT,
  ].join('\n');

// Live run 1: the session has file tools only, so it can't read $STAGE_OUT from its environment. It wrote spec.md
// into a directory it guessed, and the stage ended missing_file. The system prompt now gives it the paths.
test("the system prompt gives the session its working directory and every preamble variable's value, then the submit contract", () => {
  const req = request('Write `$STAGE_OUT/spec.md` from `$INPUT_BRIEF`.');
  const env = { ...req.env, INPUT_BRIEF: join(req.env.STAGE_IN ?? '', 'brief.md') };
  const { systemPrompt } = sessionOptions({ ...req, env }, {});
  expect(systemPrompt).toEqual({
    type: 'preset',
    preset: 'claude_code',
    append: [
      '## Where you work',
      '',
      `Your working directory is the workspace, ${req.cwd}. You have no shell, so you can't read environment`,
      'variables: where a prompt names one of these, it means the value given.',
      '',
      `- \`$STAGE_IN\`: ${req.env.STAGE_IN}`,
      `- \`$STAGE_OUT\`: ${req.env.STAGE_OUT}`,
      '- `$TRY`: 1',
      `- \`$INPUT_BRIEF\`: ${req.env.STAGE_IN}/brief.md`,
      '',
      'A file the step produces goes straight into `$STAGE_OUT` under its own name, as `$STAGE_OUT/<name>`, not into a',
      'directory below it.',
      '',
      SUBMIT_CONTRACT,
    ].join('\n'),
  });
});

test("the session's options are the step's model, workspace, envelope and budgets, isolated from the user's settings", () => {
  const req = request();
  const options = sessionOptions(req, {});
  // The gate's own options are the next test's.
  const {
    abortController,
    canUseTool: _canUseTool,
    hooks: _hooks,
    settings: _settings,
    tools: _tools,
    disallowedTools: _disallowed,
    env: _env,
    ...rest
  } = options;
  expect(rest as Record<string, unknown>).toEqual({
    cwd: req.cwd,
    model: 'claude-opus-5-5',
    additionalDirectories: [req.env.STAGE_IN, req.env.STAGE_OUT],
    settingSources: [],
    skills: [],
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
    includePartialMessages: false,
    thinking: { type: 'adaptive', display: 'summarized' },
    permissionMode: 'default',
    outputFormat: { type: 'json_schema', schema: submissionEnvelope(req.outputSchema) },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: appended(req) },
    maxTurns: 40,
    maxBudgetUsd: 2,
  });
  expect({
    controller: abortController instanceof AbortController && !abortController.signal.aborted,
    bypass: ['allowedTools', 'allowDangerouslySkipPermissions'].filter((name) => name in options),
    mode: options.permissionMode === 'bypassPermissions',
  }).toEqual({ controller: true, bypass: [], mode: false });
});

test('the session gates every call with one PreToolUse hook and the fallback, is offered only the tools its step can use, and asks no rule', () => {
  const req = request();
  const options = sessionOptions(req, {});
  const matchers = options.hooks?.PreToolUse ?? [];
  const offered = ['Read', 'Glob', 'Grep', 'Write', 'Edit'];
  expect({
    events: Object.keys(options.hooks ?? {}),
    matchers: matchers.map((matcher) => ({
      matcher: 'matcher' in matcher,
      hooks: matcher.hooks.map((hook) => typeof hook),
    })),
    canUseTool: typeof options.canUseTool,
    settings: options.settings,
    tools: options.tools,
    disallowedTools: options.disallowedTools,
  }).toEqual({
    events: ['PreToolUse'],
    matchers: [{ matcher: false, hooks: ['function'] }],
    canUseTool: 'function',
    settings: { autoMemoryEnabled: false },
    tools: offered,
    disallowedTools: BUILTIN_TOOLS.filter((name) => !offered.includes(name)),
  });
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
    TYPESAFE_API_KEY: 'ts-x',
    SECRET_TOKEN: 'no',
    GITHUB_TOKEN: 'no',
    NODE_OPTIONS: '--inspect',
    STAGE_OUT: '/not/the/preamble',
    MISSING: undefined,
  };
  const {
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: _scrub,
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: _cwd,
    CLAUDE_CODE_SHELL: _shell,
    SHELL: _bash,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: _background,
    ...picked
  } = sessionOptions(req, env).env ?? {};
  expect(picked).toEqual({
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
    TYPESAFE_API_KEY: 'ts-x',
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
  expect(summary(result)).toBe(`error: budget exceeded: maxTurns 40: ${OVER_TURNS}`);
  expect(types.filter((type) => type === 'error:harness')).toHaveLength(1);
  expect(capture.events.slice(-2)).toEqual([
    { type: 'error:harness', message: `budget exceeded: maxTurns 40: ${OVER_TURNS}` },
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

test("a session that hit the usage limit ends usage_limit, with the reset time in its text read against the harness's clock", async () => {
  const limit = "You've hit your session limit · resets 4:20pm (Europe/Sofia)";
  const query = scriptedQuery([[init(), resultSuccess({ isError: true, result: limit, cost: 0, models: {} })]]);
  const harness = createClaudeCodeHarness({ env: {}, query, now: () => Date.parse('2030-01-01T15:00:00Z') });
  const result = await harness.run({ ...request(), onEvent: () => {} });
  expect(result).toMatchObject({ outcome: 'error', reason: 'usage_limit', resetsAt: '2030-01-02T14:20:00.000Z' });
});

// Live run 1: the SDK's throw after an error result named no budget, and it took the result's place.
test('a throw after an error result leaves the result to decide, but an onEvent that throws after it still fails the session', async () => {
  const late = [
    init(),
    resultError('error_max_budget_usd', { errors: ['Reached maximum budget ($2)'] }),
    assistantText('m9', 'Late.'),
    { act: 'throw', message: 'Claude Code returned an error result: Reached maximum budget ($2)' },
  ] as const;
  const restated = await play(late);
  const deaf = await createClaudeCodeHarness({ env: {}, query: scriptedQuery([late]) }).run({
    ...request(),
    onEvent: (event) => {
      if (event.type === 'agent:message') throw new Error('not listening');
    },
  });
  expect({ restated: summary(restated.result), deaf: summary(deaf) }).toEqual({
    restated: 'error: budget exceeded: maxUsd 2: Reached maximum budget ($2)',
    deaf: 'error: claude-code: not listening',
  });
});

test('a call that reaches the fallback is denied and recorded, its tool ends denied, and the session still submits', async () => {
  const { query, result, capture } = await play([
    init(),
    assistantToolUse('m1', 't1', 'Bash', { command: 'cat ~/.ssh/id_rsa' }, { usage: { output: 5 } }),
    { act: 'useTool', tool: 'Bash', input: { command: 'cat ~/.ssh/id_rsa' }, toolUseID: 't1' },
    toolResult('t1', { isError: true }),
    resultSuccess({ structured: done(SPEC) }),
  ]);
  const message = 'Bash reached the fallback: the gate decides every tool call before it runs';
  expect(query.verdicts).toEqual([{ behavior: 'deny', message }]);
  expect(capture.events.find((event) => event.type === 'permission:denied')).toEqual({
    type: 'permission:denied',
    callId: 't1',
    tool: 'Bash',
    rule: 'commands',
    permissions: { commands: [] },
    reason: message,
  });
  const end = capture.events.at(-1);
  expect({
    toolEnd: capture.events.find((event) => event.type === 'tool:end'),
    denials: end?.type === 'harness:session_end' ? end.denials : undefined,
    outcome: result.outcome,
  }).toEqual({
    toolEnd: { type: 'tool:end', callId: 't1', status: 'denied', durationMs: 5, result: 'ok' },
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
      'usage: turn 1, in 10, cache read 300, cache write 0, out 20, $0.00028',
      'tool t1 completed in 5 ms',
      'assistant: Spec written.',
      'usage: turn 2, in 15, cache read 300, cache write 60, out 60, $0.00093',
      `usage: turn 2, in 120, cache read 5000, cache write 800, out 340, $${COST}`,
      'ended: done',
    ].join('\n'),
  );
});

test('claude-code declares structured output, permissions, usage and abort', () => {
  const { budgets: _budgets, ...rest } = createClaudeCodeHarness({ env: {} }).capabilities();
  expect(rest).toEqual({ structuredOutput: true, permissions: true, usage: true, abort: true });
  expect(createClaudeCodeHarness({ env: {} }).name).toBe('claude-code');
});

test("the session's environment turns on the credential scrub and the fixed Bash directory, whatever sail's says", () => {
  const env = sessionOptions(request(), {
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '0',
  }).env;
  expect([env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR]).toEqual(['1', '1']);
});

// Review R1-1, R1-6, R1-7: the CLI runs the Bash tool under zsh when it finds one, but decide() reads bash, and zsh's
// `>!` writes where bash's doesn't. Background tasks are off, and no preamble value turns a switch back.
test("the session's Bash is bash, it has no background tasks, and neither sail's environment nor the preamble undoes a switch", () => {
  const plain = request();
  const switches = {
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '0',
    CLAUDE_CODE_SHELL: '/bin/zsh',
    SHELL: '/bin/zsh',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0',
  };
  const env = sessionOptions({ ...plain, env: { ...plain.env, ...switches } }, switches).env;
  expect({
    scrub: env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
    cwd: env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR,
    shell: env?.CLAUDE_CODE_SHELL,
    SHELL: env?.SHELL,
    background: env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
  }).toEqual({ scrub: '1', cwd: '1', shell: '/bin/bash', SHELL: '/bin/bash', background: '1' });
});

test('a step with commands is told its variables are in its environment too, where one without is told it has no shell', () => {
  const req = request('Write the spec.', {
    permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git status'] },
  });
  const { systemPrompt } = sessionOptions(req, {});
  expect(systemPrompt).toEqual({
    type: 'preset',
    preset: 'claude_code',
    append: [
      '## Where you work',
      '',
      `Your working directory is the workspace, ${req.cwd}. Where a prompt names one of these environment`,
      'variables, it means the value given: the same values are in your environment.',
      '',
      `- \`$STAGE_IN\`: ${req.env.STAGE_IN}`,
      `- \`$STAGE_OUT\`: ${req.env.STAGE_OUT}`,
      '- `$TRY`: 1',
      '',
      'A file the step produces goes straight into `$STAGE_OUT` under its own name, as `$STAGE_OUT/<name>`, not into a',
      'directory below it.',
      '',
      SUBMIT_CONTRACT,
    ].join('\n'),
  });
});

/** The events of `types` among `events`, each as its type and the fields a test names. */
const only = (events: readonly HarnessEvent[], ...types: string[]) =>
  events.filter((event) => types.includes(event.type));

test("commands ['git status']: the gate denies tail README.md through run(), the session records it and carries on to submit", async () => {
  const permissions = { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git status'] };
  const { query, result, capture } = await play(
    [
      init({ tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'] }),
      assistantToolUse('m1', 't1', 'Bash', { command: 'tail README.md' }, { usage: { output: 5 } }),
      { act: 'preToolUse', tool: 'Bash', input: { command: 'tail README.md' }, toolUseID: 't1' },
      toolResult('t1', { isError: true }),
      assistantText('m2', 'That command is not allowed; submitting.', { usage: { output: 7 } }),
      resultSuccess({ structured: done(SPEC) }),
    ],
    { permissions },
  );
  const cwd = query.calls[0]?.options.cwd ?? '';
  const ruled = decide({ tool: 'Bash', kind: 'execute', paths: [], command: 'tail README.md', cwd }, permissions, {
    worktree: cwd,
    stageIn: query.calls[0]?.options.env?.STAGE_IN ?? '',
    stageOut: query.calls[0]?.options.env?.STAGE_OUT ?? '',
    env: {},
  });
  const reason = ruled.allow ? '' : ruled.reason;
  expect({
    outcome: summary(result),
    verdicts: query.verdicts,
    events: only(capture.events, 'tool:start', 'permission:denied', 'tool:end').map(({ type, ...rest }) =>
      type === 'tool:end' ? `${type} ${(rest as { status: string }).status}` : type === 'tool:start' ? type : rest,
    ),
    denials:
      capture.events.at(-1)?.type === 'harness:session_end'
        ? (capture.events.at(-1) as { denials: number }).denials
        : -1,
  }).toEqual({
    outcome: SPEC,
    verdicts: [
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      },
    ],
    events: [
      'tool:start',
      { callId: 't1', tool: 'Bash', rule: 'commands', permissions: { commands: ['git status'] }, reason },
      'tool:end denied',
    ],
    denials: 1,
  });
  expect(eventIssues(capture.stamped('spec#1'))).toEqual([]);
});

test('through run(), an MCP call with no tools and a write outside the workspace are denied and recorded, and a read inside runs', async () => {
  const outside = join(tmpdir(), 'sail-harness-elsewhere', 'x.md');
  const { query, result, capture } = await play([
    init(),
    assistantToolUse('m1', 't1', 'mcp__linear__get_issue', { id: 'ADW-1' }),
    { act: 'preToolUse', tool: 'mcp__linear__get_issue', input: { id: 'ADW-1' }, toolUseID: 't1' },
    toolResult('t1', { isError: true }),
    assistantToolUse('m2', 't2', 'Write', { file_path: outside, content: 'x' }),
    { act: 'preToolUse', tool: 'Write', input: { file_path: outside, content: 'x' }, toolUseID: 't2' },
    toolResult('t2', { isError: true }),
    assistantToolUse('m3', 't3', 'Read', { file_path: 'README.md' }),
    { act: 'preToolUse', tool: 'Read', input: { file_path: 'README.md' }, toolUseID: 't3' },
    toolResult('t3'),
    resultSuccess({ structured: done(SPEC) }),
  ]);
  const decisions = query.verdicts.map(
    (verdict) =>
      (verdict as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision,
  );
  expect({
    outcome: summary(result),
    decisions,
    denied: only(capture.events, 'permission:denied').map((event) =>
      event.type === 'permission:denied' ? [event.callId, event.rule, event.permissions] : [],
    ),
    ends: only(capture.events, 'tool:end').map((event) => (event.type === 'tool:end' ? event.status : '')),
  }).toEqual({
    outcome: SPEC,
    decisions: ['deny', 'deny', 'allow'],
    denied: [
      ['t1', 'tools', { tools: [] }],
      ['t2', 'write', { write: ['$STAGE_OUT/**'] }],
    ],
    ends: ['denied', 'denied', 'completed'],
  });
});

test('claude-code declares turn, dollar and minute budgets, as the port reads them', () => {
  const capabilities = createClaudeCodeHarness({ env: {} }).capabilities();
  expect({ budgets: capabilities.budgets, issues: parseIssues(HarnessCapabilities, capabilities) }).toEqual({
    budgets: ['turns', 'usd', 'minutes'],
    issues: [],
  });
});

/** The budget events among `events`, then the error and the end, as one line each. */
const budgetTrail = (events: readonly HarnessEvent[]) =>
  only(events, 'budget:warning', 'budget:exceeded', 'error:harness', 'harness:session_end').map((event) => {
    if (event.type === 'budget:warning' || event.type === 'budget:exceeded') {
      return `${event.type} ${event.budget} ${event.used} of ${event.limit}`;
    }
    if (event.type === 'error:harness') return `${event.type} ${event.message}`;
    return `${event.type} ${event.type === 'harness:session_end' ? event.reason : ''}`;
  });

test('maxUsd 0.05 over at 0.051 ends in error budget exceeded: maxUsd 0.05, after the dollar warning and overrun', async () => {
  const { result, capture } = await play(
    [
      init(),
      assistantText('m1', 'Working.', { usage: { output: 10 } }),
      resultError('error_max_budget_usd', { cost: 0.051, numTurns: 1 }),
    ],
    { budget: { maxTurns: 40, maxUsd: 0.05, maxMinutes: 10 } },
  );
  expect({ result: summary(result), reason: result.outcome === 'error' ? result.reason : '' }).toEqual({
    result: 'error: budget exceeded: maxUsd 0.05',
    reason: 'budget_exceeded',
  });
  expect(budgetTrail(capture.events)).toEqual([
    'budget:warning usd 0.051 of 0.05',
    'budget:exceeded usd 0.051 of 0.05',
    'error:harness budget exceeded: maxUsd 0.05',
    'harness:session_end max_budget_usd',
  ]);
  expect(eventIssues(capture.stamped('spec#1'))).toEqual([]);
});

test('maxTurns 2 with two closed turns ends in error naming maxTurns 2, after one turns warning and one overrun', async () => {
  const { result, capture } = await play(
    [
      init(),
      assistantToolUse('m1', 't1', 'Read', { file_path: 'a.md' }, { usage: { output: 5 } }),
      toolResult('t1'),
      assistantToolUse('m2', 't2', 'Read', { file_path: 'b.md' }, { usage: { output: 5 } }),
      toolResult('t2'),
      resultError('error_max_turns', { numTurns: 2 }),
    ],
    { budget: { maxTurns: 2, maxUsd: 2, maxMinutes: 10 } },
  );
  expect(summary(result)).toBe('error: budget exceeded: maxTurns 2');
  expect(budgetTrail(capture.events)).toEqual([
    'budget:warning turns 2 of 2',
    'budget:exceeded turns 2 of 2',
    'error:harness budget exceeded: maxTurns 2',
    'harness:session_end max_turns',
  ]);
  expect(eventIssues(capture.stamped('spec#1'))).toEqual([]);
});

test("a session's last turn, closed only as it ends, still counts toward the turns warning", async () => {
  const { result, capture } = await play(SUITE.done ?? [], { budget: { maxTurns: 2, maxUsd: 2, maxMinutes: 10 } });
  expect({ result: summary(result), trail: budgetTrail(capture.events) }).toEqual({
    result: SPEC,
    trail: ['budget:warning turns 2 of 2', 'harness:session_end submitted'],
  });
});

/**
 * Runs `stream` on fake timers, with maxMinutes 1: once the session starts, `whileRunning` moves the clock; a run that
 * hasn't ended a second after is aborted, so a harness without the minute budget fails its assertions, not its timeout.
 */
async function onTheClock(
  stream: Stream,
  whileRunning: (timers: ReturnType<typeof fakeTimers>, query: ReturnType<typeof scriptedQuery>) => Promise<void>,
) {
  const timers = fakeTimers('2026-10-15T09:00:00.000Z');
  const query = scriptedQuery([stream]);
  const harness = createClaudeCodeHarness({ env: {}, query, timers, now: () => timers.now().getTime() });
  const capture = captureEvents<HarnessEvent>();
  const controller = new AbortController();
  let started: () => void = () => undefined;
  const start = new Promise<void>((done) => {
    started = done;
  });
  const pendingAtStart: { ms: number }[] = [];
  const running = harness.run({
    ...request(),
    budget: { maxTurns: 40, maxUsd: 2, maxMinutes: 1 },
    signal: controller.signal,
    onEvent: (event) => {
      capture.emit(event);
      if (event.type === 'harness:session_start') {
        pendingAtStart.push(...timers.pending().map(({ ms }) => ({ ms })));
        started();
      }
    },
  });
  await Promise.race([start, running]);
  await whileRunning(timers, query);
  const late = setTimeout(() => controller.abort(), 1_000);
  const result = await running;
  clearTimeout(late);
  return { result, capture, query, timers, pendingAtStart };
}

test('maxMinutes 1 on the clock: the warning at 48 s, the overrun at 60 s aborts the session, which ends in error naming maxMinutes', async () => {
  const { result, capture, query, timers } = await onTheClock([init(), { act: 'waitForAbort' }], async (clock) => {
    await clock.advance(48_000);
    await clock.advance(12_000);
  });
  expect({
    result: summary(result),
    reason: result.outcome === 'error' ? result.reason : '',
    aborted: query.calls[0]?.options.abortController?.signal.aborted,
    pending: timers.pending(),
  }).toEqual({ result: 'error: budget exceeded: maxMinutes 1', reason: 'budget_exceeded', aborted: true, pending: [] });
  expect(budgetTrail(capture.events)).toEqual([
    'budget:warning minutes 0.8 of 1',
    'budget:exceeded minutes 1 of 1',
    'error:harness budget exceeded: maxMinutes 1',
    'harness:session_end max_minutes',
  ]);
  expect(eventIssues(capture.stamped('spec#1'))).toEqual([]);
});

const WORKED = assistantText('m1', 'Working.', { usage: { input: 1000, output: 1000 } });

const endUsage = (events: readonly HarnessEvent[]) =>
  events.find((event) => event.type === 'harness:session_end')?.usage?.costUsd;

test("a minute overrun interrupts the session, and the result that follows gives the session's cost, not the abort", async () => {
  const stream = [init(), WORKED, { act: 'waitForInterrupt' }, resultError('error_during_execution', { cost: 0.0731 })];
  const seen: { interrupts: number; aborted: boolean | undefined }[] = [];
  const { result, capture, timers } = await onTheClock(stream as Stream, async (clock, query) => {
    await clock.advance(60_000);
    seen.push({ interrupts: query.interrupts, aborted: query.calls[0]?.options.abortController?.signal.aborted });
  });
  expect({
    seen,
    result: summary(result),
    cost: result.usage.costUsd,
    ended: endUsage(capture.events),
    pending: timers.pending(),
  }).toEqual({
    seen: [{ interrupts: 1, aborted: false }],
    result: 'error: budget exceeded: maxMinutes 1',
    cost: 0.0731,
    ended: 0.0731,
    pending: [],
  });
});

test("an aborted request signal interrupts the session, and the result that follows gives the session's cost", async () => {
  const query = scriptedQuery([
    [init(), WORKED, { act: 'waitForInterrupt' }, resultError('error_during_execution', { cost: 0.0731 })],
  ]);
  const controller = new AbortController();
  const result = await createClaudeCodeHarness({ env: {}, query }).run({
    ...request(),
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'harness:session_start') controller.abort();
    },
  });
  expect({
    interrupts: query.interrupts,
    aborted: query.calls[0]?.options.abortController?.signal.aborted,
    result: summary(result),
    cost: result.usage.costUsd,
  }).toEqual({ interrupts: 1, aborted: false, result: 'error: aborted', cost: 0.0731 });
});

test('a cut session that sends no result within INTERRUPT_GRACE_MS is aborted, and ends with the estimate of its turns', async () => {
  const seen: (boolean | undefined)[] = [];
  const { result, query, timers } = await onTheClock(
    [init(), WORKED, { act: 'waitForInterrupt' }, { act: 'waitForAbort' }],
    async (clock, query) => {
      const aborted = () => query.calls[0]?.options.abortController?.signal.aborted;
      await clock.advance(60_000);
      seen.push(aborted());
      await clock.advance(INTERRUPT_GRACE_MS - 1);
      seen.push(aborted());
      await clock.advance(1);
      seen.push(aborted());
    },
  );
  expect({
    seen,
    interrupts: query.interrupts,
    result: summary(result),
    cost: result.usage.costUsd,
    pending: timers.pending(),
  }).toEqual({
    seen: [false, false, true],
    interrupts: 1,
    result: 'error: budget exceeded: maxMinutes 1',
    cost: 0.012,
    pending: [],
  });
});

test('a session that ends inside its minutes set both timers at its start, leaves none, and says nothing of minutes', async () => {
  const { result, capture, timers, pendingAtStart } = await onTheClock(SUITE.done ?? [], async () => undefined);
  expect({
    result: summary(result),
    pendingAtStart,
    pending: timers.pending(),
    budget: budgetTrail(capture.events).filter((line) => line.startsWith('budget')),
  }).toEqual({ result: SPEC, pendingAtStart: [{ ms: 48_000 }, { ms: 60_000 }], pending: [], budget: [] });
});

// The process group (D7): a stand-in tree spawned through the session's spawner, and gone when run() resolves.
const TREE = { act: 'spawn', command: '/bin/sh', args: ['-c', 'sleep 30 & sleep 30'] } as const;
const spawnedPids: number[] = [];
afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
  }
});

/** Whether the group `pgid` is gone within `ms`: macOS answers EPERM while its last members exit, ESRCH once gone. */
async function groupGone(pgid: number | undefined, ms = 2_000): Promise<boolean> {
  if (pgid === undefined) return false;
  const deadline = performance.now() + ms;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    if (performance.now() > deadline) return false;
    await Bun.sleep(25);
  }
}

test('an aborted session leaves no process of its group behind when run() resolves', async () => {
  const controller = new AbortController();
  const query = scriptedQuery([[init(), TREE, { act: 'waitForAbort' }]]);
  const result = await createClaudeCodeHarness({ env: {}, query }).run({
    ...request(),
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'harness:session_start') setTimeout(() => controller.abort(), 200);
    },
  });
  spawnedPids.push(...query.pids);
  expect({ result: summary(result), spawned: query.pids.length, gone: await groupGone(query.pids[0]) }).toEqual({
    result: 'error: aborted',
    spawned: 1,
    gone: true,
  });
}, 30_000);

test('a session over its minutes leaves no process of its group behind when run() resolves', async () => {
  const { result, query } = await onTheClock([init(), TREE, { act: 'waitForAbort' }], async (clock) => {
    await Bun.sleep(200);
    await clock.advance(60_000);
  });
  spawnedPids.push(...query.pids);
  expect({ result: summary(result), spawned: query.pids.length, gone: await groupGone(query.pids[0]) }).toEqual({
    result: 'error: budget exceeded: maxMinutes 1',
    spawned: 1,
    gone: true,
  });
}, 30_000);

test('a session that submits while its tree still runs leaves none of it behind when run() resolves', async () => {
  const { query, result } = await play([init(), TREE, ...(SUITE.done ?? []).slice(1)]);
  spawnedPids.push(...query.pids);
  expect({ result: summary(result), spawned: query.pids.length, gone: await groupGone(query.pids[0]) }).toEqual({
    result: SPEC,
    spawned: 1,
    gone: true,
  });
}, 30_000);

describe('onRaw: the provider messages, handed on for a recording', () => {
  const answer: SDKMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello from the tool', is_error: false }],
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  };
  const stream = (): Stream => [
    init(),
    assistantToolUse('m1', 't1', 'Read', { file_path: 'brief.md' }),
    answer,
    resultSuccess({ structured: done(SPEC) }),
  ];

  test('onRaw gets each SDK message, in order and as the same objects', async () => {
    const messages = stream() as SDKMessage[];
    const got: unknown[] = [];
    await play(messages, { onRaw: (raw) => got.push(raw) });
    expect(got.length).toBe(4);
    messages.forEach((message, index) => {
      expect(got[index]).toBe(message);
    });
    const block = (got[2] as { message: { content: { content: string }[] } }).message.content[0];
    expect(block?.content).toBe('hello from the tool');
  });

  test('an onRaw that throws on every call changes nothing', async () => {
    const plain = await play(stream());
    const throwing = await play(stream(), {
      onRaw: () => {
        throw new Error('disk full');
      },
    });
    expect(throwing.capture.events).toEqual(plain.capture.events);
    expect(throwing.result.outcome).toBe('done');
    expect({
      outcome: throwing.result.outcome,
      output: summary(throwing.result),
      usage: throwing.result.usage,
      transcript: throwing.result.transcript,
    }).toEqual({
      outcome: plain.result.outcome,
      output: summary(plain.result),
      usage: plain.result.usage,
      transcript: plain.result.transcript,
    });
  });

  test('a request without onRaw runs as it did', async () => {
    const { result } = await play(stream());
    expect(summary(result)).toEqual(SPEC);
  });
});
