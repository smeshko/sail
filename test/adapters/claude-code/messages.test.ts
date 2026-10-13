// The message mapper: one SDK message in, the harness events it gives out, with the session's tool and text activity and
// nothing else (TASK-002).
import { expect, test } from 'bun:test';
import { type MapState, mapMessage, startMapping } from '../../../src/adapters/claude-code/messages';
import type { SDKMessage } from '../../../src/adapters/claude-code/sdk';
import type { HarnessEvent } from '../../../src/ports/harness';
import { captureEvents, eventIssues } from '../../helpers/ports';
import { assistant, init, MODEL, SESSION_ID, success, text, thinking, toolResult, toolUse, typesOf } from './helpers';

const KEY = 'spec#1';

/** A state whose clock reads each of `times` in turn, then zero. */
function clockAt(...times: number[]): MapState {
  const queue = [...times];
  return startMapping(KEY, MODEL, () => queue.shift() ?? 0);
}

/** The events of each message in turn, flattened: the session as the mapper sees it. */
function mapAll(messages: readonly SDKMessage[], state: MapState): HarnessEvent[] {
  return messages.flatMap((message) => mapMessage(message, state));
}

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('the init message starts the session: harness:session_start with the claude-code adapter, the init session id and the request model', () => {
  expect(mapMessage(init(), clockAt())).toEqual([
    { type: 'harness:session_start', adapter: 'claude-code', sessionId: SESSION_ID, model: MODEL },
  ]);
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a repeated init gives no second session start, and the messages after it still map', () => {
  const state = clockAt();
  const events = mapAll([init(), init(), assistant('msg_1', [text('Reading the brief.')])], state);
  expect(events).toEqual([
    { type: 'harness:session_start', adapter: 'claude-code', sessionId: SESSION_ID, model: MODEL },
    { type: 'agent:message', text: 'Reading the brief.' },
  ]);
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('an assistant message gives its thinking, text and tool calls in the message order, with the tool input', () => {
  const events = mapMessage(
    assistant('msg_1', [
      thinking('Plan the spec.'),
      text('Reading.'),
      toolUse('toolu_1', 'Read', { file_path: 'brief.md' }),
      text('Done.'),
    ]),
    clockAt(),
  );
  expect(events).toEqual([
    { type: 'agent:thinking', text: 'Plan the spec.' },
    { type: 'agent:message', text: 'Reading.' },
    { type: 'tool:start', callId: 'toolu_1', tool: 'Read', input: { file_path: 'brief.md' } },
    { type: 'agent:message', text: 'Done.' },
  ]);
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a tool_result gives tool:end with its call id, completed or failed, and the time from its start to its end', () => {
  // The clock is read at each start (1000, then 1100) and each end (1250, then 1500).
  const state = clockAt(1000, 1100, 1250, 1500);
  const events = mapAll(
    [
      assistant('msg_1', [toolUse('toolu_1', 'Read', { file_path: 'a.md' }), toolUse('toolu_2', 'Bash', { command: 'x' })]),
      toolResult('toolu_1'),
      toolResult('toolu_2', true, 'exit 1'),
    ],
    state,
  );
  expect(events.filter((event) => event.type === 'tool:end')).toEqual([
    { type: 'tool:end', callId: 'toolu_1', status: 'completed', durationMs: 250 },
    { type: 'tool:end', callId: 'toolu_2', status: 'failed', durationMs: 400 },
  ]);
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a tool_result with no open tool:start gives nothing and does not throw, and a matched one after it still ends', () => {
  const state = clockAt(100, 180);
  const events = mapAll(
    [toolResult('toolu_orphan'), assistant('msg_1', [toolUse('toolu_1', 'Read', { file_path: 'a.md' })]), toolResult('toolu_1')],
    state,
  );
  expect(events).toEqual([
    { type: 'tool:start', callId: 'toolu_1', tool: 'Read', input: { file_path: 'a.md' } },
    { type: 'tool:end', callId: 'toolu_1', status: 'completed', durationMs: 80 },
  ]);
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a stream_event and a message of an unknown type give nothing and do not throw, and the messages around them still map', () => {
  const streamEvent = { type: 'stream_event', event: { type: 'content_block_delta' }, session_id: SESSION_ID };
  const unknown = { type: 'a_type_the_sdk_adds_later', session_id: SESSION_ID };
  const events = mapAll(
    [init(), streamEvent as unknown as SDKMessage, unknown as unknown as SDKMessage, assistant('msg_1', [text('Hi.')])],
    clockAt(),
  );
  expect(typesOf(events)).toEqual(['harness:session_start', 'agent:message']);
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('the events of a session pass sail.event.v1 once stamped, and a result message gives no event here', () => {
  const events = mapAll(
    [
      init(),
      assistant('msg_1', [text('Reading.'), toolUse('toolu_1', 'Read', { file_path: 'a.md' })], { input_tokens: 10 }),
      toolResult('toolu_1'),
      success({ structured: { outcome: 'done', output: {} }, cost: 0.01 }),
    ],
    clockAt(5, 9),
  );
  expect(typesOf(events)).toEqual(['harness:session_start', 'agent:message', 'tool:start', 'tool:end']);
  const capture = captureEvents<HarnessEvent>();
  for (const event of events) capture.emit(event);
  expect(eventIssues(capture.stamped(KEY))).toEqual([]);
});
