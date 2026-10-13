// The session transcript that session.log holds: one line per message in event order, usage lines last (TASK-005).
import { expect, test } from 'bun:test';
import { renderTranscript } from '../../../src/adapters/claude-code/transcript';
import type { HarnessEvent } from '../../../src/ports/harness';
import { MODEL, SESSION_ID } from './helpers';

const EVENTS: HarnessEvent[] = [
  { type: 'harness:session_start', adapter: 'claude-code', sessionId: SESSION_ID, model: MODEL },
  { type: 'agent:message', text: 'Reading.' },
  { type: 'agent:thinking', text: 'Plan it.' },
  { type: 'tool:start', callId: 'toolu_1', tool: 'Read', input: { file_path: 'a.md' } },
  { type: 'tool:end', callId: 'toolu_1', status: 'completed', durationMs: 12 },
  { type: 'usage:update', turn: 1, tokens: { input: 100, cacheRead: 50, cacheWrite: 10, output: 20 }, costUsdSoFar: 0 },
  { type: 'agent:message', text: 'Done.' },
  {
    type: 'usage:update',
    turn: 2,
    tokens: { input: 130, cacheRead: 50, cacheWrite: 15, output: 27 },
    costUsdSoFar: 0.0421,
  },
  {
    type: 'harness:session_end',
    sessionId: SESSION_ID,
    outcome: 'done',
    reason: 'submitted',
    turns: 2,
    toolCalls: 1,
    denials: 0,
    usage: { inputTokens: 130, cacheReadTokens: 50, cacheWriteTokens: 15, outputTokens: 27, costUsd: 0.0421 },
  },
];

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('the transcript has one line per message in event order, a usage line per turn, and the final usage line last', () => {
  const lines = renderTranscript(EVENTS).split('\n');
  expect(lines.map((line) => line.split(',')[0])).toEqual([
    'assistant: Reading.',
    'thinking: Plan it.',
    'tool: Read completed',
    'usage: turn 1',
    'assistant: Done.',
    'usage: turn 2',
  ]);
  expect(lines[3]).toContain('100');
  expect(lines.at(-1)).toContain('0.0421');
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('an empty session gives an empty transcript, and one message gives its one line', () => {
  expect([renderTranscript([]), renderTranscript([{ type: 'agent:message', text: 'Hi.' }])]).toEqual(['', 'assistant: Hi.']);
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a provider whose cost is an estimate adds one header line saying so, and the rest is unchanged', () => {
  const plain = renderTranscript(EVENTS);
  const estimated = renderTranscript(EVENTS, { provider: 'bedrock' });
  const [header, ...rest] = estimated.split('\n');
  expect({ header: /estimate/i.test(header ?? ''), rest: rest.join('\n') }).toEqual({ header: true, rest: plain });
});
