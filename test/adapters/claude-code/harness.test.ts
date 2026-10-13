// The claude-code Harness over an injected query: one session per run, its events in order, abort, the failure paths, the
// zero-budget refusal, the registered definition and the module boundary (TASK-006). Every session here is scripted, so no
// test starts a process or reaches the network.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCodeAdapters, createClaudeCodeHarness } from '../../../src/adapters/claude-code/harness';
import { renderTranscript } from '../../../src/adapters/claude-code/transcript';
import type { HarnessEvent, HarnessRequest } from '../../../src/ports/harness';
import { HarnessResult } from '../../../src/ports/types';
import { captureEvents, eventIssues, parseIssues } from '../../helpers/ports';
import {
  assistant,
  done,
  failure,
  init,
  Probe,
  requestOf,
  SESSION_ID,
  scriptedQuery,
  success,
  text,
  toolResult,
  toolUse,
  typesOf,
} from './helpers';

const ENV = { STAGE_IN: '/work/in', STAGE_OUT: '/work/out' };

/** A session that reads a brief, writes the spec and submits it. */
const COMPLETE = [
  init(),
  assistant('msg_a', [text('Reading the brief.'), toolUse('toolu_1', 'Read', { file_path: 'brief.md' })], {
    input_tokens: 100,
    output_tokens: 20,
  }),
  toolResult('toolu_1'),
  assistant('msg_b', [text('Writing the spec.')], {
    input_tokens: 30,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 5,
    output_tokens: 7,
  }),
  success({
    structured: done({ summary: 'Add a --shout flag.' }),
    cost: 0.0421,
    usage: { input_tokens: 130, output_tokens: 27, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 },
  }),
];

/** A harness over `scripts`, each prompt's session, with its clock stopped at zero. */
const harnessOver = (scripts: Parameters<typeof scriptedQuery>[0], probe = new Probe()) =>
  createClaudeCodeHarness({ query: scriptedQuery(scripts, probe), env: {}, now: () => 0 });

/** A run's result and events, captured. */
async function runWith(harness: ReturnType<typeof harnessOver>, request: HarnessRequest) {
  const capture = captureEvents<HarnessEvent>();
  const result = await harness.run({ ...request, onEvent: capture.emit });
  return { result, events: capture.events, capture };
}

test('a scripted session that reads a file and submits done gives the done result, its events in order and one session end', async () => {
  const probe = new Probe();
  const { result, events, capture } = await runWith(
    harnessOver({ 'Write the spec.': { messages: COMPLETE } }, probe),
    requestOf({ key: 'spec#1', env: ENV }),
  );
  expect(typesOf(events)).toEqual([
    'harness:session_start',
    'agent:message',
    'tool:start',
    'usage:update',
    'tool:end',
    'agent:message',
    'usage:update',
    'usage:update',
    'harness:session_end',
  ]);
  expect({
    outcome: result.outcome,
    output: result.outcome === 'done' ? result.output : undefined,
    sessionId: result.sessionId,
    usage: result.usage,
    issues: parseIssues(HarnessResult, result),
  }).toEqual({
    outcome: 'done',
    output: { summary: 'Add a --shout flag.' },
    sessionId: SESSION_ID,
    usage: { inputTokens: 130, cacheReadTokens: 50, cacheWriteTokens: 5, outputTokens: 27, costUsd: 0.0421 },
    issues: [],
  });
  expect(events.at(-1)).toEqual({
    type: 'harness:session_end',
    sessionId: SESSION_ID,
    outcome: 'done',
    reason: 'submitted',
    turns: 2,
    toolCalls: 1,
    denials: 0,
    usage: result.usage,
  });
  expect(eventIssues(capture.stamped('spec#1'))).toEqual([]);
  expect(result.transcript.split('\n').filter((line) => !line.startsWith('usage:'))).toEqual([
    'assistant: Reading the brief.',
    'tool: Read completed',
    'assistant: Writing the spec.',
  ]);
  expect(result.transcript).toBe(renderTranscript(events));
});

test('query is called once per run, with the request prompt and the session options the request names', async () => {
  const probe = new Probe();
  await runWith(
    harnessOver({ 'Write the spec.': { messages: COMPLETE } }, probe),
    requestOf({ budget: { maxTurns: 4, maxUsd: 0.5, maxMinutes: 5 } }),
  );
  expect(probe.calls.map((call) => call.prompt)).toEqual(['Write the spec.']);
  const options = probe.calls[0]?.options;
  expect({
    cwd: options?.cwd,
    model: options?.model,
    maxTurns: options?.maxTurns,
    maxBudgetUsd: options?.maxBudgetUsd,
    permissionMode: options?.permissionMode,
    settingSources: options?.settingSources,
  }).toEqual({
    cwd: '/work/fixture',
    model: 'claude-test-model',
    maxTurns: 4,
    maxBudgetUsd: 0.5,
    permissionMode: 'default',
    settingSources: [],
  });
});

test('an abort mid-stream ends the session as aborted, stops pulling messages, closes the stream and emits one session end', async () => {
  const probe = new Probe();
  const controller = new AbortController();
  const events: string[] = [];
  const result = await harnessOver(
    {
      'Write the spec.': {
        messages: [init(), assistant('msg_a', [text('one')]), assistant('msg_b', [text('two')]), ...COMPLETE.slice(4)],
      },
    },
    probe,
  ).run({
    ...requestOf(),
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event.type);
      if (event.type === 'agent:message') controller.abort();
    },
  });
  expect({
    outcome: result.outcome,
    message: result.outcome === 'error' ? result.message : undefined,
    pulled: probe.yielded,
    closed: probe.closed,
    ends: events.filter((type) => type === 'harness:session_end').length,
  }).toEqual({ outcome: 'error', message: 'aborted', pulled: 2, closed: 1, ends: 1 });
});

test('an abort the SDK surfaces as a thrown error ends the session as aborted, not as a harness failure', async () => {
  // review #1.6: the SDK throws when its process is aborted, so the catch must read the request's signal.
  const controller = new AbortController();
  const query = (params: { options: { abortController: AbortController } }) =>
    (async function* () {
      yield init();
      // The abort lands while the adapter awaits the next message, which the SDK then rejects with.
      setTimeout(() => controller.abort(), 0);
      await new Promise((_, reject) =>
        params.options.abortController.signal.addEventListener('abort', () =>
          reject(new Error('Claude Code process aborted by user')),
        ),
      );
    })();
  const result = await createClaudeCodeHarness({ query, env: { ANTHROPIC_API_KEY: 'sk-test' } }).run({
    ...requestOf(),
    signal: controller.signal,
  });
  expect({ outcome: result.outcome, message: result.outcome === 'error' ? result.message : undefined }).toEqual({
    outcome: 'error',
    message: 'aborted',
  });
});

test('a request whose signal is already aborted gives error aborted, and query is never called', async () => {
  const probe = new Probe();
  const result = await harnessOver({ 'Write the spec.': { messages: COMPLETE } }, probe).run({
    ...requestOf(),
    signal: AbortSignal.abort(),
  });
  expect({
    outcome: result.outcome,
    message: result.outcome === 'error' ? result.message : undefined,
    calls: probe.calls.length,
  }).toEqual({ outcome: 'error', message: 'aborted', calls: 0 });
});

test('a query that throws before any message gives error harness with its message, error:harness and one session end, and the run resolves', async () => {
  const { result, events } = await runWith(
    harnessOver({ 'Write the spec.': { messages: [], throwNow: new Error('spawn claude ENOENT') } }),
    requestOf(),
  );
  expect({
    outcome: result.outcome,
    reason: result.outcome === 'error' ? result.reason : undefined,
    message: result.outcome === 'error' ? result.message : undefined,
    types: typesOf(events),
  }).toEqual({
    outcome: 'error',
    reason: 'harness',
    message: expect.stringContaining('spawn claude ENOENT'),
    types: ['error:harness', 'harness:session_end'],
  });
});

test('a stream that throws after the init gives error harness, with the session started and ended once', async () => {
  const { result, events } = await runWith(
    harnessOver({ 'Write the spec.': { messages: [init()], failAfter: 1, failWith: new Error('stream reset') } }),
    requestOf(),
  );
  expect({
    outcome: result.outcome,
    reason: result.outcome === 'error' ? result.reason : undefined,
    message: result.outcome === 'error' ? result.message : undefined,
    types: typesOf(events),
  }).toEqual({
    outcome: 'error',
    reason: 'harness',
    message: expect.stringContaining('stream reset'),
    types: ['harness:session_start', 'error:harness', 'harness:session_end'],
  });
});

test('a stream that ends with no result gives error harness, and the session still ends once', async () => {
  const { result, events } = await runWith(
    harnessOver({ 'Write the spec.': { messages: [init(), assistant('msg_a', [text('Thinking.')])] } }),
    requestOf(),
  );
  expect({
    outcome: result.outcome,
    reason: result.outcome === 'error' ? result.reason : undefined,
    message: result.outcome === 'error' ? result.message : undefined,
    ends: typesOf(events).filter((type) => type === 'harness:session_end').length,
  }).toEqual({ outcome: 'error', reason: 'harness', message: expect.stringMatching(/result/i), ends: 1 });
});

test('a result error emits error:harness after the session start, and ends the session once with budget_exceeded', async () => {
  const { result, events } = await runWith(
    harnessOver({ 'Write the spec.': { messages: [init(), failure('error_max_turns')] } }),
    requestOf(),
  );
  expect({
    reason: result.outcome === 'error' ? result.reason : undefined,
    message: result.outcome === 'error' ? result.message : undefined,
    types: typesOf(events),
  }).toEqual({
    reason: 'budget_exceeded',
    message: expect.stringContaining('maxTurns'),
    types: ['harness:session_start', 'error:harness', 'harness:session_end'],
  });
});

test('run never rejects when onEvent throws, and the error carries what was thrown', async () => {
  const harness = harnessOver({ 'Write the spec.': { messages: COMPLETE } });
  const result = await harness.run({
    ...requestOf(),
    onEvent: () => {
      throw new Error('listener down');
    },
  });
  expect({
    outcome: result.outcome,
    message: result.outcome === 'error' ? result.message : undefined,
  }).toEqual({ outcome: 'error', message: expect.stringContaining('listener down') });
});

test('a zero dollar budget gives error budget_exceeded naming maxUsd, before query is called, and ends the session once without a start', async () => {
  const probe = new Probe();
  const { result, events } = await runWith(
    harnessOver({ 'Write the spec.': { messages: COMPLETE } }, probe),
    requestOf({ budget: { maxTurns: 5, maxUsd: 0, maxMinutes: 5 } }),
  );
  expect({
    reason: result.outcome === 'error' ? result.reason : undefined,
    message: result.outcome === 'error' ? result.message : undefined,
    calls: probe.calls.length,
    types: typesOf(events),
  }).toEqual({
    reason: 'budget_exceeded',
    message: expect.stringContaining('maxUsd'),
    calls: 0,
    types: ['harness:session_end'],
  });
});

test('the harness declares structured output, usage, abort and the turn and dollar budgets, with no permissions gate yet', () => {
  expect(createClaudeCodeHarness().capabilities()).toEqual({
    structuredOutput: true,
    permissions: false,
    usage: true,
    abort: true,
    budgets: ['turns', 'usd'],
  });
});

test('the definition creates a harness named claude-code, and refuses an option it does not know, naming it', async () => {
  const context = { root: '/work', sailDir: '/work/.sail', runsDir: '/work/.sail-runs', env: {} };
  const harness = await claudeCodeAdapters.create({}, context);
  expect(harness.name).toBe('claude-code');
  expect(() => claudeCodeAdapters.create({ bogus: 1 }, context)).toThrow(/bogus/);
});

test('the definition declares the pinned SDK version, which package.json pins exactly', () => {
  const pinned = JSON.parse(readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  expect({
    versions: claudeCodeAdapters.versions?.(),
    pin: pinned.dependencies['@anthropic-ai/claude-agent-sdk'],
  }).toEqual({ versions: { 'claude-agent-sdk': '0.3.282' }, pin: '0.3.282' });
});

test('only sdk.ts imports the Agent SDK in all of src, and no module in src imports the engine permissions', () => {
  // review #1.10: the boundary is the whole of src, not the claude-code folder alone.
  const src = join(import.meta.dir, '../../../src');
  const modules = readdirSync(src, { recursive: true }).filter((name) => name.endsWith('.ts'));
  // Any mention of the module by its specifier counts: a static, type-only, side-effect or dynamic import alike.
  const sourceOf = (name: string) => readFileSync(join(src, name), 'utf8');
  const importers = modules.filter((name) => /['"]@anthropic-ai\/claude-agent-sdk['"]/.test(sourceOf(name)));
  const gated = modules.filter((name) => /['"][^'"]*engine\/permissions['"]/.test(sourceOf(name)));
  expect({ importers, gated }).toEqual({ importers: [join('adapters', 'claude-code', 'sdk.ts')], gated: [] });
});
