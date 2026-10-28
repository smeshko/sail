// The pi session reader: pi's session events become sail's harness events, in order, with the denial held until its
// call ends, one cumulative usage update per closed turn, and the cost kept as each assistant message brings it.
import { expect, test } from 'bun:test';
import { RESULT_LENGTH } from '../../../src/adapters/claude-code/messages';
import type { Denial } from '../../../src/adapters/claude-code/tool-call';
import { createPiSessionReader, type PiEvent, type PiSessionReader } from '../../../src/adapters/pi/messages';
import type { HarnessEvent } from '../../../src/ports/harness';
import { agentStart, assistantEnd, PI_MODEL, PI_SESSION_ID, toolEnd, toolStart, turnEnd } from '../../helpers/pi';
import { captureEvents, eventIssues } from '../../helpers/ports';

function reader(): { reader: PiSessionReader; at: (ms: number) => void } {
  let clock = 0;
  return {
    reader: createPiSessionReader({ model: PI_MODEL, sessionId: PI_SESSION_ID, now: () => clock }),
    at: (ms) => {
      clock = ms;
    },
  };
}

const readAll = (r: PiSessionReader, events: readonly PiEvent[]): HarnessEvent[] => events.flatMap((e) => r.read(e));

const DENIAL: Denial = {
  tool: 'bash',
  rule: 'commands',
  permissions: { commands: ['git status'] },
  reason: 'tail README.md: tail is not among the allowed commands',
};

test('agent_start starts the session once, with the session id and the model asked for', () => {
  const { reader: r } = reader();
  expect({ first: r.read(agentStart()), second: r.read(agentStart()), id: r.state().sessionId }).toEqual({
    first: [{ type: 'harness:session_start', adapter: 'pi', sessionId: PI_SESSION_ID, model: PI_MODEL }],
    second: [],
    id: PI_SESSION_ID,
  });
});

test('a scripted turn gives session_start, thinking, message, tool:start, permission:denied, tool:end and usage:update in order, each valid', () => {
  const { reader: r, at } = reader();
  const capture = captureEvents<HarnessEvent>();
  const emit = (events: HarnessEvent[]) => {
    for (const event of events) capture.emit(event);
  };
  at(100);
  emit(r.read(agentStart()));
  emit(
    r.read(
      assistantEnd(
        [
          { type: 'thinking', thinking: 'The brief wants a tail.' },
          { type: 'text', text: 'Reading the readme.' },
          { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'tail README.md' } },
        ],
        { input: 100, output: 20, cacheRead: 5, cacheWrite: 7, cost: 0.002 },
      ),
    ),
  );
  emit(r.read(toolStart('t1', 'bash', { command: 'tail README.md' })));
  r.markDenied('t1', DENIAL);
  at(130);
  emit(r.read(toolEnd('t1', 'bash', DENIAL.reason, true)));
  emit(r.read(turnEnd()));
  expect(capture.events).toEqual([
    { type: 'harness:session_start', adapter: 'pi', sessionId: PI_SESSION_ID, model: PI_MODEL },
    { type: 'agent:thinking', text: 'The brief wants a tail.' },
    { type: 'agent:message', text: 'Reading the readme.' },
    { type: 'tool:start', callId: 't1', tool: 'bash', input: { command: 'tail README.md' } },
    { type: 'permission:denied', callId: 't1', ...DENIAL },
    { type: 'tool:end', callId: 't1', status: 'denied', durationMs: 30, result: DENIAL.reason },
    {
      type: 'usage:update',
      turn: 1,
      tokens: { input: 100, cacheRead: 5, cacheWrite: 7, output: 20 },
      costUsdSoFar: 0.002,
    },
  ]);
  expect(eventIssues(capture.stamped('spec#1'))).toEqual([]);
  expect({ denials: r.state().denials, toolCalls: r.state().toolCalls, events: r.state().events }).toEqual({
    denials: 1,
    toolCalls: 1,
    events: capture.events,
  });
});

test('empty text is nothing, and redacted thinking is [redacted]', () => {
  const { reader: r } = reader();
  const events = readAll(r, [
    assistantEnd([
      { type: 'text', text: '' },
      { type: 'thinking', thinking: '', redacted: true },
      { type: 'text', text: 'Done.' },
    ]),
  ]);
  expect(events).toEqual([
    { type: 'agent:thinking', text: '[redacted]' },
    { type: 'agent:message', text: 'Done.' },
  ]);
});

test('usage and cost add up over the messages of a session, the cost known at once and the update at each turn end', () => {
  const { reader: r } = reader();
  readAll(r, [agentStart(), assistantEnd([{ type: 'text', text: 'a' }], { input: 10, output: 5, cost: 0.01 })]);
  const afterMessage = r.state().spent;
  const first = r.read(turnEnd());
  r.read(assistantEnd([{ type: 'text', text: 'b' }], { input: 20, output: 7, cacheRead: 3, cost: 0.02 }));
  const second = r.read(turnEnd());
  expect({ afterMessage, first, second, turns: r.state().turns, spent: r.state().spent }).toEqual({
    afterMessage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, costUsd: 0.01 },
    first: [
      {
        type: 'usage:update',
        turn: 1,
        tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 },
        costUsdSoFar: 0.01,
      },
    ],
    second: [
      {
        type: 'usage:update',
        turn: 2,
        tokens: { input: 30, cacheRead: 3, cacheWrite: 0, output: 12 },
        costUsdSoFar: 0.03,
      },
    ],
    turns: 2,
    spent: { inputTokens: 30, cacheReadTokens: 3, cacheWriteTokens: 0, outputTokens: 12, costUsd: 0.03 },
  });
});

test('a tool that failed ends failed, its result is cut to RESULT_LENGTH, and a result without text adds none', () => {
  const { reader: r, at } = reader();
  at(10);
  readAll(r, [agentStart(), toolStart('t1', 'bash', { command: 'false' }), toolStart('t2', 'read', { path: 'x' })]);
  at(25);
  const failed = r.read(toolEnd('t1', 'bash', 'x'.repeat(RESULT_LENGTH + 50), true));
  const bare = r.read({
    type: 'tool_execution_end',
    toolCallId: 't2',
    toolName: 'read',
    result: { content: [{ type: 'image', data: '', mimeType: 'image/png' }] },
    isError: false,
  });
  expect({ failed, bare }).toEqual({
    failed: [
      { type: 'tool:end', callId: 't1', status: 'failed', durationMs: 15, result: `${'x'.repeat(RESULT_LENGTH)}…` },
    ],
    bare: [{ type: 'tool:end', callId: 't2', status: 'completed', durationMs: 15 }],
  });
});

test('a denial heard before its tool:start still comes out before the tool:end, never before the start', () => {
  const { reader: r } = reader();
  r.read(agentStart());
  r.markDenied('t1', DENIAL);
  const start = r.read(toolStart('t1', 'bash', { command: 'tail README.md' }));
  const end = r.read(toolEnd('t1', 'bash', 'refused', true));
  expect([...start, ...end].map((event) => event.type)).toEqual(['tool:start', 'permission:denied', 'tool:end']);
});

test('settle fails each tool still open, emits a denial still held, and closes nothing twice', () => {
  const { reader: r } = reader();
  readAll(r, [agentStart(), toolStart('t1', 'read', { path: 'a' }), toolStart('t2', 'bash', { command: 'x' })]);
  r.markDenied('t2', DENIAL);
  const settled = r.settle();
  expect({ types: settled.map((e) => e.type), again: r.settle() }).toEqual({
    types: ['tool:end', 'permission:denied', 'tool:end'],
    again: [],
  });
  expect(settled.filter((e) => e.type === 'tool:end').map((e) => 'status' in e && e.status)).toEqual([
    'failed',
    'denied',
  ]);
});

test('an assistant message that errored keeps its text as a failure, and events it does not know read as nothing', () => {
  const { reader: r } = reader();
  const events = readAll(r, [
    agentStart(),
    { type: 'queue_update', steering: [], followUp: [] },
    assistantEnd([], undefined, { stopReason: 'error', errorMessage: '429 rate limit exceeded' }),
    { type: 'message_end', message: { role: 'user', content: 'hi' } },
  ]);
  expect({ types: events.map((e) => e.type), failures: r.state().failures }).toEqual({
    types: ['harness:session_start'],
    failures: ['429 rate limit exceeded'],
  });
});
