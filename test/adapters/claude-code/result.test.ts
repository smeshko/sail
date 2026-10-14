// How a session's ending becomes one HarnessResult: a submission is done or blocked, and everything else is error with
// the provider's text kept. A zero-token or empty result never counts as success (ADR-0008).
import { expect, test } from 'bun:test';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSessionReader } from '../../../src/adapters/claude-code/messages';
import { type ResultInput, toHarnessResult } from '../../../src/adapters/claude-code/result';
import { HarnessResult } from '../../../src/ports/types';
import {
  assistantText,
  authStatus,
  COST,
  done,
  INVALID_KEY,
  init,
  MODEL,
  modelUsage,
  resultError,
  resultSuccess,
  SESSION_ID,
  SPENT,
} from '../../helpers/claude-code';
import { parseIssues } from '../../helpers/ports';

const BUDGET = { maxTurns: 40, maxUsd: 2, maxMinutes: 10 };
const SPEC = { summary: 'Add a flag.', tasks: ['Add it'] };
/** What a session that spent SPENT for COST reports. */
const USAGE = { inputTokens: 120, cacheReadTokens: 5000, cacheWriteTokens: 800, outputTokens: 340, costUsd: COST };

/** The input for a session that said `messages` and ended with `result`, read by the real reader. */
function ending(
  result: SDKResultMessage | undefined,
  messages: SDKMessage[] = [init()],
  extra: Partial<ResultInput> = {},
) {
  const reader = createSessionReader({ adapter: 'claude-code', model: MODEL, now: () => 0 });
  for (const message of messages) reader.read(message);
  reader.settle(result);
  return toHarnessResult({ result, reader: reader.state(), budget: BUDGET, aborted: false, ...extra });
}

/** An ended session as one value: its outcome's own field, its reason, its end reason, and its issues as a result. */
function summary(ended: ReturnType<typeof toHarnessResult>): Record<string, unknown> {
  const { result } = ended;
  return {
    said: result.outcome === 'done' ? result.output : result.outcome === 'blocked' ? result.reason : result.message,
    outcome: result.outcome,
    reason: result.outcome === 'error' ? result.reason : undefined,
    endReason: ended.endReason,
    issues: parseIssues(HarnessResult, result),
  };
}

test('a success that submits done gives done with its output, the session id, the spend from modelUsage at the total cost, and the result as raw', () => {
  const result = resultSuccess({ structured: done(SPEC) });
  const ended = ending(result);
  expect(ended.result).toEqual({
    outcome: 'done',
    output: SPEC,
    sessionId: SESSION_ID,
    usage: USAGE,
    transcript: '',
    raw: result,
  });
  expect({ endReason: ended.endReason, issues: parseIssues(HarnessResult, ended.result) }).toEqual({
    endReason: 'submitted',
    issues: [],
  });
});

test('a success that submits blocked gives blocked with its reason', () => {
  const ended = ending(resultSuccess({ structured: { outcome: 'blocked', reason: 'No acceptance criteria.' } }));
  expect(summary(ended)).toEqual({
    said: 'No acceptance criteria.',
    outcome: 'blocked',
    reason: undefined,
    endReason: 'blocked',
    issues: [],
  });
});

test("an API error keeps the provider's text, once, with any other failure the session reported after it", () => {
  const invalid = resultSuccess({ isError: true, result: INVALID_KEY, cost: 0, models: {} });
  const once = ending(invalid, [init(), assistantText('m1', INVALID_KEY, { error: 'authentication_failed' })]);
  const more = ending(invalid, [init(), authStatus('token expired')]);
  expect([summary(once), summary(more)]).toEqual([
    {
      said: `the session failed: ${INVALID_KEY}`,
      outcome: 'error',
      reason: 'harness',
      endReason: 'failed',
      issues: [],
    },
    {
      said: `the session failed: ${INVALID_KEY}; token expired`,
      outcome: 'error',
      reason: 'harness',
      endReason: 'failed',
      issues: [],
    },
  ]);
});

const failure = (said: string, endReason = 'failed', reason = 'harness') => ({
  said,
  outcome: 'error',
  reason,
  endReason,
  issues: [],
});

test.each<[string, SDKResultMessage | undefined, ReturnType<typeof failure>]>([
  ['a success with no submission', resultSuccess(), failure('the session ended without submitting')],
  [
    'a success whose submission is unreadable',
    resultSuccess({ structured: 'done' }),
    failure('the submission is a string, not an envelope'),
  ],
  [
    'a success that reports no tokens, though it submitted',
    resultSuccess({ structured: done(SPEC), result: '', cost: 0, models: { [MODEL]: modelUsage({}, 0) } }),
    failure('the session reported no usage'),
  ],
  [
    'a success with no model usage at all, and a cost',
    resultSuccess({ structured: done(SPEC), cost: 0.01, models: {} }),
    failure('the session reported no usage'),
  ],
  [
    'error_max_turns',
    resultError('error_max_turns'),
    failure('budget exceeded: maxTurns 40', 'max_turns', 'budget_exceeded'),
  ],
  [
    'error_max_budget_usd',
    resultError('error_max_budget_usd'),
    failure('budget exceeded: maxUsd 2', 'max_budget_usd', 'budget_exceeded'),
  ],
  // Live run 1: the budget is named, and the SDK's own text kept after it.
  [
    'error_max_turns with the SDK text',
    resultError('error_max_turns', { errors: ['Reached maximum number of turns (40)'] }),
    failure('budget exceeded: maxTurns 40: Reached maximum number of turns (40)', 'max_turns', 'budget_exceeded'),
  ],
  [
    'error_max_budget_usd with the SDK text',
    resultError('error_max_budget_usd', { errors: ['Reached maximum budget ($2)', 'over'] }),
    failure('budget exceeded: maxUsd 2: Reached maximum budget ($2); over', 'max_budget_usd', 'budget_exceeded'),
  ],
  [
    'error_max_structured_output_retries',
    resultError('error_max_structured_output_retries', { errors: ['tasks: required', 'summary: too long'] }),
    failure('the output never matched its schema: tasks: required; summary: too long', 'max_structured_output_retries'),
  ],
  [
    'error_during_execution',
    resultError('error_during_execution', { errors: ['overloaded'] }),
    failure('the session failed during execution: overloaded'),
  ],
  [
    'error_during_execution with no errors',
    resultError('error_during_execution'),
    failure('the session failed during execution'),
  ],
  ['no result', undefined, failure('the session ended without a result')],
])('%s is error', (_, result, expected) => {
  expect(summary(ending(result))).toEqual(expected);
});

test.each<[string, unknown, boolean, string]>([
  ['an Error', new Error('spawn claude ENOENT'), false, 'claude-code: spawn claude ENOENT'],
  ['a string', 'stream closed', false, 'claude-code: stream closed'],
  ['null', null, false, 'claude-code: null'],
  ['undefined', undefined, false, 'claude-code: undefined'],
  ['an Error after an abort', new Error('Claude Code process aborted by user'), true, 'aborted'],
])('a session that threw %s is error with its message', (_, error, aborted, message) => {
  const ended = ending(undefined, [init()], { thrown: { error }, aborted });
  expect(summary(ended)).toEqual(failure(message, aborted ? 'aborted' : 'failed'));
});

test('an aborted session is error aborted, even when a result came', () => {
  expect(summary(ending(resultSuccess({ structured: done(SPEC) }), [init()], { aborted: true }))).toEqual(
    failure('aborted', 'aborted'),
  );
});

test("the session id is the init's, else the result's, else empty", () => {
  const result = resultSuccess({ structured: done(SPEC), sessionId: 'from-result' });
  expect([
    ending(result, [init({ sessionId: 'from-init' })]).result.sessionId,
    ending(result, []).result.sessionId,
    ending(undefined, []).result.sessionId,
  ]).toEqual(['from-init', 'from-result', '']);
});

test.each<[string, string | undefined, boolean]>([
  ['bedrock', 'bedrock', true],
  ['vertex', 'vertex', true],
  ['the first party', 'firstParty', false],
  ['no provider', undefined, false],
])("a result on %s is a cost estimate only where its provider's is", (_, provider, estimate) => {
  const result = resultSuccess({ structured: done(SPEC), models: { [MODEL]: modelUsage(SPENT, COST, provider) } });
  const ended = ending(result);
  expect({ raw: ended.result.raw, costEstimate: ended.costEstimate }).toEqual({
    raw: estimate ? { ...result, costEstimate: true } : result,
    costEstimate: estimate,
  });
});
