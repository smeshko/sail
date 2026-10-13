// The session's result as the harness result: each result subtype ends in `error` with the reason the port names, the
// success guards hold, and every result the module gives parses as a HarnessResult (TASK-005).
import { expect, test } from 'bun:test';
import { resultOf } from '../../../src/adapters/claude-code/result';
import type { SDKResultMessage } from '../../../src/adapters/claude-code/sdk';
import { HarnessResult, type Usage } from '../../../src/ports/types';
import { parseIssues } from '../../helpers/ports';
import { blocked, done, failure, SESSION_ID, success } from './helpers';

const USAGE: Usage = { inputTokens: 130, cacheReadTokens: 50, cacheWriteTokens: 15, outputTokens: 27, costUsd: 0.0421 };
const CONTEXT = { sessionId: SESSION_ID, usage: USAGE, transcript: 'assistant: Hi.' };
const NO_TOKENS: Usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 };

/** A result's outcome, reason and message, with the result's own parse issues. */
function summary(message: SDKResultMessage, context = CONTEXT) {
  const result = resultOf(message, context);
  return {
    outcome: result.outcome,
    reason: result.outcome === 'error' ? result.reason : undefined,
    message: result.outcome === 'error' ? result.message : undefined,
    issues: parseIssues(HarnessResult, result),
  };
}

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a success whose structured output unwraps to done gives the output, the session id, the usage, the transcript and the raw result', () => {
  const message = success({ structured: done({ summary: 'Add a --shout flag.' }), cost: 0.0421, usage: {} });
  const result = resultOf(message, CONTEXT);
  expect({
    outcome: result.outcome,
    output: result.outcome === 'done' ? result.output : undefined,
    sessionId: result.sessionId,
    usage: result.usage,
    transcript: result.transcript,
    raw: result.raw,
    issues: parseIssues(HarnessResult, result),
  }).toEqual({
    outcome: 'done',
    output: { summary: 'Add a --shout flag.' },
    sessionId: SESSION_ID,
    usage: USAGE,
    transcript: 'assistant: Hi.',
    raw: message,
    issues: [],
  });
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a success whose structured output unwraps to blocked gives the blocked outcome with its reason', () => {
  expect(summary(success({ structured: blocked('The brief has no acceptance criteria.') }))).toEqual({
    outcome: 'blocked',
    reason: undefined,
    message: undefined,
    issues: [],
  });
  const result = resultOf(success({ structured: blocked('The brief has no acceptance criteria.') }), CONTEXT);
  expect(result.outcome === 'blocked' ? result.reason : undefined).toBe('The brief has no acceptance criteria.');
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('error_max_turns ends in error with reason budget_exceeded, and a message that names maxTurns', () => {
  expect(summary(failure('error_max_turns'))).toEqual({
    outcome: 'error',
    reason: 'budget_exceeded',
    message: expect.stringContaining('maxTurns'),
    issues: [],
  });
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('error_max_budget_usd ends in error with reason budget_exceeded, and a message that names maxUsd', () => {
  expect(summary(failure('error_max_budget_usd'))).toEqual({
    outcome: 'error',
    reason: 'budget_exceeded',
    message: expect.stringContaining('maxUsd'),
    issues: [],
  });
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('error_during_execution ends in error with reason harness, and its message carries each error the SDK gave', () => {
  expect(summary(failure('error_during_execution', ['Tool crashed', 'Retry later']))).toEqual({
    outcome: 'error',
    reason: 'harness',
    message: expect.stringMatching(/Tool crashed.*Retry later/),
    issues: [],
  });
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('error_max_structured_output_retries ends in error with reason harness, carrying the SDK error', () => {
  expect(summary(failure('error_max_structured_output_retries', ['Output never matched the schema']))).toEqual({
    outcome: 'error',
    reason: 'harness',
    message: expect.stringContaining('Output never matched the schema'),
    issues: [],
  });
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a success with no structured output ends in error with reason harness, never in done', () => {
  expect(summary(success({ result: 'I wrote it.' }))).toEqual({
    outcome: 'error',
    reason: 'harness',
    message: expect.stringMatching(/structured/i),
    issues: [],
  });
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a success whose structured output is not a well-formed envelope ends in error with reason harness', () => {
  expect(summary(success({ structured: { outcome: 'retry', output: {} } }))).toEqual({
    outcome: 'error',
    reason: 'harness',
    message: expect.stringMatching(/envelope|structured/i),
    issues: [],
  });
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('a success with zero tokens ends in error with reason harness, never in done', () => {
  expect(summary(success({ structured: done({ summary: 'ok' }) }), { ...CONTEXT, usage: NO_TOKENS })).toEqual({
    outcome: 'error',
    reason: 'harness',
    message: expect.stringMatching(/token/i),
    issues: [],
  });
});

// biome-ignore format: TDD-PENDING TASK-005
test
  .skip // TDD-PENDING TASK-005
  ('an error result with no error text still gives a message that names its subtype', () => {
  expect(summary(failure('error_during_execution', []))).toEqual({
    outcome: 'error',
    reason: 'harness',
    message: expect.stringContaining('error_during_execution'),
    issues: [],
  });
});
