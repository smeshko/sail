// The transcript the agent kind keeps as session.log: one block per event worth reading, in order, and how the session
// ended.
import { expect, test } from 'bun:test';
import { renderTranscript } from '../../../src/adapters/claude-code/transcript';
import type { HarnessEvent } from '../../../src/ports/harness';

const tokens = { input: 120, cacheRead: 5000, cacheWrite: 800, output: 340 };

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a five-event session renders as this golden text, with no newline at its end', () => {
  const events: HarnessEvent[] = [
    { type: 'harness:session_start', adapter: 'claude-code', sessionId: 'cc-1', model: 'claude-sonnet-5' },
    { type: 'agent:message', text: 'Reading the brief.' },
    { type: 'tool:start', callId: 't1', tool: 'Read', input: { file_path: 'brief.md' } },
    { type: 'tool:end', callId: 't1', status: 'completed', durationMs: 25 },
    { type: 'usage:update', turn: 1, tokens, costUsdSoFar: 0.0425 },
  ];
  expect(renderTranscript(events, { outcome: 'done' })).toBe(
    [
      'session cc-1 on claude-sonnet-5',
      'assistant: Reading the brief.',
      'tool Read {"file_path":"brief.md"} [t1]',
      'tool t1 completed in 25 ms',
      'usage: turn 1, in 120, cache read 5000, cache write 800, out 340, $0.0425',
      'ended: done',
    ].join('\n'),
  );
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('thoughts, failed and denied tools, errors and a blocked end each get their line, multi-line text indented, and other events none', () => {
  const events: HarnessEvent[] = [
    { type: 'agent:thinking', text: 'First.\nSecond.' },
    { type: 'tool:end', callId: 't2', status: 'failed', durationMs: 3 },
    { type: 'tool:end', callId: 't3', status: 'denied', durationMs: 0 },
    { type: 'budget:warning', budget: 'turns', limit: 40, used: 32 },
    { type: 'error:harness', message: 'the session failed: overloaded' },
    { type: 'harness:session_end', outcome: 'blocked', turns: 1, toolCalls: 2, denials: 1, usage: { costUsd: 0 } },
  ];
  expect(
    renderTranscript(events, { outcome: 'blocked', message: 'No criteria.\nAsk the author.' }).split('\n'),
  ).toEqual([
    'thinking: First.',
    '  Second.',
    'tool t2 failed in 3 ms',
    'tool t3 denied in 0 ms',
    'error: the session failed: overloaded',
    'ended: blocked: No criteria.',
    '  Ask the author.',
  ]);
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ("an estimated cost marks the last usage line, and only that one, as not the provider's bill", () => {
  const events: HarnessEvent[] = [
    { type: 'usage:update', turn: 1, tokens, costUsdSoFar: 0 },
    { type: 'usage:update', turn: 2, tokens, costUsdSoFar: 0.05 },
    { type: 'agent:message', text: 'Done.' },
  ];
  expect(renderTranscript(events, { outcome: 'done', costEstimate: true }).split('\n')).toEqual([
    'usage: turn 1, in 120, cache read 5000, cache write 800, out 340, $0',
    "usage: turn 2, in 120, cache read 5000, cache write 800, out 340, $0.05 (estimate: not the provider's bill)",
    'assistant: Done.',
    'ended: done',
  ]);
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('no events and no end render as nothing, and a session with no events as its end alone', () => {
  expect([renderTranscript([]), renderTranscript([], { outcome: 'error', message: 'aborted' })]).toEqual([
    '',
    'ended: error: aborted',
  ]);
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a tool input with a newline or a control character stays on one line, cut at 200 characters', () => {
  const long = 'x'.repeat(300);
  const text = renderTranscript([
    { type: 'tool:start', callId: 't1', tool: 'Write', input: { file_path: 'a.md', content: 'one\ntwo\u0007' } },
    { type: 'tool:start', callId: 't2', tool: 'Write', input: { content: long } },
  ]);
  const json = JSON.stringify({ content: long });
  expect(text.split('\n')).toEqual([
    'tool Write {"file_path":"a.md","content":"one\\ntwo\\u0007"} [t1]',
    `tool Write ${json.slice(0, 200)}… [t2]`,
  ]);
});
