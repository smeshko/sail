// The session reader: SDK messages become sail's harness events, in order, with one cumulative usage update per closed
// turn, deduplicated by message id, and the result's own update at the end (D3, D4, D13, D14).
import { expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSessionReader, type SessionReader } from '../../../src/adapters/claude-code/messages';
import type { Denial } from '../../../src/adapters/claude-code/tool-call';
import type { HarnessEvent } from '../../../src/ports/harness';
import {
  assistantRedacted,
  assistantText,
  assistantThinking,
  assistantToolUse,
  authStatus,
  init,
  MODEL,
  modelUsage,
  resultSuccess,
  SESSION_ID,
  streamEvent,
  toolResult,
} from '../../helpers/claude-code';
import { captureEvents, eventIssues } from '../../helpers/ports';

/** A reader on a clock the test sets. */
function reader(model = 'request-model'): { reader: SessionReader; at: (ms: number) => void } {
  let clock = 0;
  return {
    reader: createSessionReader({ adapter: 'claude-code', model, now: () => clock }),
    at: (ms) => {
      clock = ms;
    },
  };
}

/** Reads each message in turn, and gives every event they made. */
const readAll = (r: SessionReader, messages: readonly SDKMessage[]): HarnessEvent[] =>
  messages.flatMap((message) => r.read(message));

const updates = (events: readonly HarnessEvent[]) => events.filter((event) => event.type === 'usage:update');

test('the init message starts the session once, with its session id and model, or the request model when it reports none', () => {
  const { reader: r } = reader();
  const first = r.read(init());
  const second = r.read(init({ sessionId: 'another', model: 'another-model' }));
  const { reader: bare } = reader('request-model');
  expect({ first, second, bare: bare.read(init({ model: '' })), state: r.state().sessionId }).toEqual({
    first: [{ type: 'harness:session_start', adapter: 'claude-code', sessionId: SESSION_ID, model: MODEL }],
    second: [],
    bare: [{ type: 'harness:session_start', adapter: 'claude-code', sessionId: SESSION_ID, model: 'request-model' }],
    state: SESSION_ID,
  });
});

test('text and thinking blocks become messages and thoughts, an empty text nothing, and redacted thinking [redacted]', () => {
  const { reader: r } = reader();
  const events = readAll(r, [
    assistantText('m1', 'Reading the brief.'),
    assistantThinking('m1', 'The brief asks for a flag.'),
    assistantText('m1', ''),
    assistantRedacted('m1'),
    assistantText('m1', 'Line one.\nLine two.'),
  ]);
  expect(events).toEqual([
    { type: 'agent:message', text: 'Reading the brief.' },
    { type: 'agent:thinking', text: 'The brief asks for a flag.' },
    { type: 'agent:thinking', text: '[redacted]' },
    { type: 'agent:message', text: 'Line one.\nLine two.' },
  ]);
});

test('a tool use starts a tool call, and its result ends it completed, failed or denied, timed by the clock', () => {
  const { reader: r, at } = reader();
  at(1000);
  const started = readAll(r, [
    assistantToolUse('m1', 't1', 'Read', { file_path: 'a.ts' }),
    assistantToolUse('m1', 't2', 'Write', { file_path: 'b.ts' }),
    assistantToolUse('m1', 't3', 'Edit', { file_path: 'c.ts' }),
  ]);
  r.markDenied('t3');
  at(1250);
  const ended = readAll(r, [
    toolResult('t1'),
    toolResult('t2', { isError: true }),
    toolResult('t3'),
    toolResult('nope'),
  ]);
  expect(started).toEqual([
    { type: 'tool:start', callId: 't1', tool: 'Read', input: { file_path: 'a.ts' } },
    { type: 'tool:start', callId: 't2', tool: 'Write', input: { file_path: 'b.ts' } },
    { type: 'tool:start', callId: 't3', tool: 'Edit', input: { file_path: 'c.ts' } },
  ]);
  expect(ended.filter((event) => event.type === 'tool:end')).toEqual([
    { type: 'tool:end', callId: 't1', status: 'completed', durationMs: 250 },
    { type: 'tool:end', callId: 't2', status: 'failed', durationMs: 250 },
    { type: 'tool:end', callId: 't3', status: 'denied', durationMs: 250 },
  ]);
  expect({ toolCalls: r.state().toolCalls, denials: r.state().denials }).toEqual({ toolCalls: 3, denials: 1 });
});

test('the messages of one turn share an id: the turn is counted once, when the next id comes, with the last usage it carried', () => {
  const { reader: r } = reader();
  const usage = (output: number) => ({ usage: { input: 10, output, cacheRead: 300, cacheWrite: 40 } });
  const turnOne = readAll(r, [
    assistantText('m1', 'a', usage(1)),
    assistantText('m1', 'b', usage(5)),
    assistantText('m1', 'c', usage(9)),
  ]);
  const next = r.read(assistantText('m2', 'd', { usage: { input: 2, output: 3 } }));
  expect({ turnOne: updates(turnOne), next: updates(next) }).toEqual({
    turnOne: [],
    next: [
      {
        type: 'usage:update',
        turn: 1,
        tokens: { input: 10, cacheRead: 300, cacheWrite: 40, output: 9 },
        costUsdSoFar: 0,
      },
    ],
  });
});

test('parallel tool calls of one turn close it once, and each update is the running total of the closed turns, at no cost yet', () => {
  const { reader: r } = reader();
  const events = readAll(r, [
    assistantToolUse('m1', 'a', 'Read', { file_path: 'a.ts' }, { usage: { input: 10, output: 4, cacheRead: 100 } }),
    assistantToolUse('m1', 'b', 'Read', { file_path: 'b.ts' }, { usage: { input: 10, output: 8, cacheRead: 100 } }),
    toolResult('a'),
    toolResult('b'),
    assistantText('m2', 'Read both.', { usage: { input: 5, output: 6, cacheWrite: 20 } }),
    assistantText('m3', 'Done.', { usage: { input: 1, output: 1 } }),
  ]);
  expect(updates(events)).toEqual([
    { type: 'usage:update', turn: 1, tokens: { input: 10, cacheRead: 100, cacheWrite: 0, output: 8 }, costUsdSoFar: 0 },
    {
      type: 'usage:update',
      turn: 2,
      tokens: { input: 15, cacheRead: 100, cacheWrite: 20, output: 14 },
      costUsdSoFar: 0,
    },
  ]);
  expect(r.state().spent).toEqual({
    inputTokens: 15,
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
    outputTokens: 14,
    costUsd: 0,
  });
});

// Review R1-4: the CLI runs a tool while the model still writes the turn, so a tool's result can come between two
// messages of one id. The turn is still counted once, with the last usage its id carried.
test("a tool result between two messages of one turn doesn't count the turn twice: its id keeps its last usage", () => {
  const { reader: r } = reader();
  const events = readAll(r, [
    assistantToolUse('m1', 'a', 'Read', { file_path: 'a.ts' }, { usage: { input: 10, output: 4, cacheRead: 100 } }),
    toolResult('a'),
    assistantToolUse('m1', 'b', 'Read', { file_path: 'b.ts' }, { usage: { input: 10, output: 8, cacheRead: 100 } }),
    toolResult('b'),
    assistantText('m2', 'Read both.', { usage: { input: 5, output: 6 } }),
  ]);
  const settled = r.settle(undefined);
  const tokens = (input: number, output: number) => ({ input, cacheRead: 100, cacheWrite: 0, output });
  expect([...updates(events), ...updates(settled)]).toEqual([
    { type: 'usage:update', turn: 1, tokens: tokens(10, 4), costUsdSoFar: 0 },
    { type: 'usage:update', turn: 1, tokens: tokens(10, 8), costUsdSoFar: 0 },
    { type: 'usage:update', turn: 2, tokens: tokens(15, 14), costUsdSoFar: 0 },
  ]);
  expect({ turns: r.state().turns, input: r.state().spent.inputTokens }).toEqual({ turns: 2, input: 15 });
});

test("settling on a result closes the open turn, then gives the result's totals over every model, at its total cost", () => {
  const { reader: r } = reader();
  r.read(assistantText('m1', 'Done.', { usage: { input: 3, output: 7 } }));
  const result = resultSuccess({
    numTurns: 5,
    cost: 0.3,
    models: {
      'claude-sonnet-5': modelUsage({ input: 100, output: 200, cacheRead: 3000, cacheWrite: 400 }, 0.25),
      'claude-haiku-5': modelUsage({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, 0.05),
    },
  });
  const settled = r.settle(result);
  expect(settled).toEqual([
    { type: 'usage:update', turn: 1, tokens: { input: 3, cacheRead: 0, cacheWrite: 0, output: 7 }, costUsdSoFar: 0 },
    {
      type: 'usage:update',
      turn: 5,
      tokens: { input: 110, cacheRead: 3030, cacheWrite: 440, output: 220 },
      costUsdSoFar: 0.3,
    },
  ]);
  const last = settled.at(-1);
  expect(last?.type === 'usage:update' ? last.costUsdSoFar : undefined).toBe(result.total_cost_usd);
  expect({ spent: r.state().spent, turns: r.state().turns }).toEqual({
    spent: { inputTokens: 110, cacheReadTokens: 3030, cacheWriteTokens: 440, outputTokens: 220, costUsd: 0.3 },
    turns: 5,
  });
});

test("the result's update takes the turns counted when they are more than the result's num_turns", () => {
  const { reader: r } = reader();
  readAll(r, [assistantText('m1', 'a'), assistantText('m2', 'b'), assistantText('m3', 'c')]);
  const last = r.settle(resultSuccess({ numTurns: 1 })).at(-1);
  expect({ turn: last?.type === 'usage:update' ? last.turn : undefined, turns: r.state().turns }).toEqual({
    turn: 3,
    turns: 3,
  });
});

test("a subagent's messages are no turns of the session: their tokens count only through the result", () => {
  const { reader: r } = reader();
  const events = readAll(r, [
    assistantText('m1', 'Delegating.', { usage: { input: 10, output: 10 } }),
    assistantText('s1', 'Sub one.', { usage: { input: 1000, output: 1000 }, parent: 'task-1' }),
    assistantText('s2', 'Sub two.', { usage: { input: 1000, output: 1000 }, parent: 'task-1' }),
    assistantText('m2', 'Back.', { usage: { input: 20, output: 20 } }),
  ]);
  const settled = r.settle(undefined);
  expect(updates([...events, ...settled])).toEqual([
    { type: 'usage:update', turn: 1, tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 10 }, costUsdSoFar: 0 },
    { type: 'usage:update', turn: 2, tokens: { input: 30, cacheRead: 0, cacheWrite: 0, output: 30 }, costUsdSoFar: 0 },
  ]);
  expect(r.state().turns).toBe(2);
});

test('a stream event, a status, an API retry, a hook or a result between the messages of a session emits nothing and changes nothing', () => {
  const quiet: SDKMessage[] = [
    streamEvent(),
    { type: 'system', subtype: 'status', status: 'requesting', uuid: init().uuid, session_id: SESSION_ID },
    {
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 500,
      error_status: 529,
      error: 'overloaded',
      uuid: init().uuid,
      session_id: SESSION_ID,
    },
    {
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'h1',
      hook_name: 'h',
      hook_event: 'PreToolUse',
      uuid: init().uuid,
      session_id: SESSION_ID,
    },
    resultSuccess(),
  ];
  const said: SDKMessage[] = [
    init(),
    assistantText('m1', 'Working.', { usage: { output: 3 } }),
    assistantText('m2', 'Done.', { usage: { output: 4 } }),
  ];
  const { reader: plain } = reader();
  const { reader: noisy } = reader();
  const events = readAll(noisy, [said[0], ...quiet, said[1], ...quiet, said[2], ...quiet] as SDKMessage[]);
  expect(events).toEqual([
    { type: 'harness:session_start', adapter: 'claude-code', sessionId: SESSION_ID, model: MODEL },
    { type: 'agent:message', text: 'Working.' },
    { type: 'usage:update', turn: 1, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 3 }, costUsdSoFar: 0 },
    { type: 'agent:message', text: 'Done.' },
  ]);
  readAll(plain, said);
  expect(noisy.state()).toEqual(plain.state());
});

test("the session's failures are kept in order with the provider's text: an assistant error, an auth status error", () => {
  const { reader: r } = reader();
  readAll(r, [
    assistantText('m1', 'Invalid API key · Fix external API key', { error: 'authentication_failed' }),
    authStatus('token expired'),
    authStatus(),
    assistantText('m2', '', { error: 'billing_error' }),
  ]);
  expect(r.state().failures).toEqual(['Invalid API key · Fix external API key', 'token expired', 'billing_error']);
});

test('settling with no result closes the open turn and fails every open tool, with no result update', () => {
  const { reader: r, at } = reader();
  at(100);
  readAll(r, [
    assistantToolUse('m1', 't1', 'Read', { file_path: 'a.ts' }, { usage: { output: 4 } }),
    assistantToolUse('m1', 't2', 'Grep', { pattern: 'x' }, { usage: { output: 6 } }),
  ]);
  at(160);
  expect(r.settle(undefined)).toEqual([
    { type: 'usage:update', turn: 1, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 6 }, costUsdSoFar: 0 },
    { type: 'tool:end', callId: 't1', status: 'failed', durationMs: 60 },
    { type: 'tool:end', callId: 't2', status: 'failed', durationMs: 60 },
  ]);
});

test('every event of a whole session, stamped with its key, is valid against sail.event.v1, and the state keeps them in order', () => {
  const { reader: r } = reader();
  const capture = captureEvents<HarnessEvent>();
  const messages: SDKMessage[] = [
    init(),
    assistantThinking('m1', 'Plan.', { usage: { input: 5, output: 5 } }),
    assistantRedacted('m1'),
    assistantText('m1', 'Reading.'),
    assistantToolUse('m1', 't1', 'Read', { file_path: 'a.ts' }),
    toolResult('t1'),
    assistantToolUse('m2', 't2', 'Write', { file_path: 'b.ts' }, { usage: { input: 1, output: 2 } }),
    toolResult('t2', { isError: true }),
    assistantToolUse('m3', 't3', 'Edit', { file_path: 'c.ts' }),
  ];
  for (const event of readAll(r, messages)) capture.emit(event);
  r.markDenied('t3');
  for (const event of r.settle(resultSuccess())) capture.emit(event);
  expect(capture.events.map((event) => event.type)).toEqual([
    'harness:session_start',
    'agent:thinking',
    'agent:thinking',
    'agent:message',
    'tool:start',
    'usage:update',
    'tool:end',
    'tool:start',
    'usage:update',
    'tool:end',
    'tool:start',
    'usage:update',
    'tool:end',
    'usage:update',
  ]);
  expect(eventIssues(capture.stamped('spec#1'))).toEqual([]);
  expect(r.state().events).toEqual(capture.events);
});

const DENIAL: Denial = {
  tool: 'Bash',
  rule: 'commands',
  permissions: { commands: ['git status'] },
  reason: 'tail README.md: tail is not among the allowed commands',
};

test('a denied call emits permission:denied with its denial just before its tool:end denied, and counts once', () => {
  const { reader: r, at } = reader();
  const capture = captureEvents<HarnessEvent>();
  at(100);
  for (const event of r.read(init())) capture.emit(event);
  for (const event of r.read(assistantToolUse('m1', 't1', 'Bash', { command: 'tail README.md' }))) capture.emit(event);
  r.markDenied('t1', DENIAL);
  at(130);
  for (const event of r.read(toolResult('t1', { isError: true }))) capture.emit(event);
  expect(capture.events.slice(1)).toEqual([
    { type: 'tool:start', callId: 't1', tool: 'Bash', input: { command: 'tail README.md' } },
    { type: 'usage:update', turn: 1, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, costUsdSoFar: 0 },
    { type: 'permission:denied', callId: 't1', ...DENIAL },
    { type: 'tool:end', callId: 't1', status: 'denied', durationMs: 30 },
  ]);
  expect(r.state().denials).toBe(1);
  expect(eventIssues(capture.stamped('spec#1'))).toEqual([]);
});

test('a denial heard before its tool use arrives still comes out after the tool:start', () => {
  const { reader: r } = reader();
  r.markDenied('t1', DENIAL);
  const events = readAll(r, [
    assistantToolUse('m1', 't1', 'Bash', { command: 'tail README.md' }),
    toolResult('t1', { isError: true }),
  ]);
  expect(events.map((event) => event.type)).toEqual(['tool:start', 'usage:update', 'permission:denied', 'tool:end']);
});

test("settling emits a held denial ahead of its call's failed end, and one for a call never started alone", () => {
  const { reader: r, at } = reader();
  at(10);
  readAll(r, [assistantToolUse('m1', 't1', 'Bash', { command: 'tail README.md' })]);
  r.markDenied('t1', DENIAL);
  r.markDenied('t9', { ...DENIAL, tool: 'Read', rule: 'read', permissions: { read: ['src/**'] }, reason: 'no' });
  at(15);
  expect(r.settle(undefined).slice(1)).toEqual([
    { type: 'permission:denied', callId: 't1', ...DENIAL },
    { type: 'tool:end', callId: 't1', status: 'denied', durationMs: 5 },
    {
      type: 'permission:denied',
      callId: 't9',
      tool: 'Read',
      rule: 'read',
      permissions: { read: ['src/**'] },
      reason: 'no',
    },
  ]);
  expect(r.state().denials).toBe(2);
});
