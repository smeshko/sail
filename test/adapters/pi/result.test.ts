// How a pi session ended, as one HarnessResult: a submission is done or blocked, a budget overrun is budget_exceeded
// naming its budget, and everything else is error with the provider's text kept.
import { expect, test } from 'bun:test';
import type { ReaderState } from '../../../src/adapters/claude-code/messages';
import { type PiResultInput, toHarnessResult } from '../../../src/adapters/pi/result';

const BUDGET = { maxTurns: 12, maxUsd: 0.5, maxMinutes: 7 };
const SPENT = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20, costUsd: 0.01 };

function state(extra: Partial<ReaderState> = {}): ReaderState {
  return { sessionId: 's-1', turns: 2, toolCalls: 1, denials: 0, spent: SPENT, failures: [], events: [], ...extra };
}

const end = (input: Partial<PiResultInput> = {}) =>
  toHarnessResult({ reader: state(), submission: undefined, budget: BUDGET, aborted: false, ...input });

test('a done submission is done with its output, the session id and usage, and ends submitted', () => {
  const ended = end({ submission: { outcome: 'done', output: { title: 'T' } } });
  expect(ended).toEqual({
    result: { outcome: 'done', output: { title: 'T' }, sessionId: 's-1', usage: SPENT, transcript: '', raw: null },
    endReason: 'submitted',
    costEstimate: false,
  });
});

test('a blocked submission is blocked with its reason', () => {
  const ended = end({ submission: { outcome: 'blocked', reason: 'No ticket.' } });
  expect(ended.result).toEqual({
    outcome: 'blocked',
    reason: 'No ticket.',
    sessionId: 's-1',
    usage: SPENT,
    transcript: '',
    raw: null,
  });
  expect(ended.endReason).toBe('blocked');
});

test('over turns is budget_exceeded naming maxTurns, over dollars maxUsd, over minutes maxMinutes', () => {
  const pick = (over: 'turns' | 'usd' | 'minutes') => {
    const { result, endReason } = end({ over, submission: { outcome: 'done', output: {} } });
    return result.outcome === 'error' ? [result.reason, result.message, endReason] : result.outcome;
  };
  expect([pick('turns'), pick('usd'), pick('minutes')]).toEqual([
    ['budget_exceeded', 'budget exceeded: maxTurns 12', 'max_turns'],
    ['budget_exceeded', 'budget exceeded: maxUsd 0.5', 'max_budget_usd'],
    ['budget_exceeded', 'budget exceeded: maxMinutes 7', 'max_minutes'],
  ]);
});

test('an aborted session is an error saying aborted, whatever it submitted', () => {
  const ended = end({ aborted: true, submission: { outcome: 'done', output: {} } });
  expect(ended.result).toMatchObject({ outcome: 'error', reason: 'harness', message: 'aborted' });
  expect(ended.endReason).toBe('aborted');
});

test('a session that threw is an error carrying pi’s text', () => {
  const ended = end({ thrown: { error: new Error('connect ECONNREFUSED') } });
  expect(ended.result).toMatchObject({ outcome: 'error', reason: 'harness', message: 'pi: connect ECONNREFUSED' });
  expect(ended.endReason).toBe('failed');
});

test('a throw that is the usage limit is usage_limit, with the reset time its text gives', () => {
  const text = "You've hit your limit · resets 3pm (UTC)";
  const ended = end({ thrown: { error: new Error(text) }, now: new Date('2026-10-15T09:00:00.000Z') });
  expect(ended.result).toMatchObject({ outcome: 'error', reason: 'usage_limit', resetsAt: '2026-10-15T15:00:00.000Z' });
  expect(ended.endReason).toBe('usage_limit');
});

test('provider failures read before the end are the error when nothing was submitted, and the limit when they say so', () => {
  const plain = end({ reader: state({ failures: ['401 invalid api key'] }) });
  const limited = end({ reader: state({ failures: ["429 You've hit your usage limit"] }) });
  expect(plain.result).toMatchObject({
    outcome: 'error',
    reason: 'harness',
    message: 'the session failed: 401 invalid api key',
  });
  expect(limited.result).toMatchObject({ outcome: 'error', reason: 'usage_limit' });
});

test("Codex's limit is usage_limit with its try-again time, and only the last failure read decides", () => {
  const now = new Date('2026-10-30T01:00:00.000Z');
  const codex = end({ reader: state({ failures: ['Codex error: The usage limit has been reached'] }), now });
  const timed = end({
    reader: state({ failures: ['You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.'] }),
    now,
  });
  const retried = end({ reader: state({ failures: ['429 Too Many Requests', 'connect ECONNREFUSED'] }) });
  expect(
    [codex, timed, retried].map(({ result, endReason }) => [
      result.outcome,
      endReason,
      'resetsAt' in result ? result.resetsAt : null,
    ]),
  ).toEqual([
    ['error', 'usage_limit', null],
    ['error', 'usage_limit', '2026-10-30T01:42:00.000Z'],
    ['error', 'failed', null],
  ]);
  expect(retried.result).toMatchObject({
    reason: 'harness',
    message: 'the session failed: 429 Too Many Requests; connect ECONNREFUSED',
  });
});

test('a session that ended without submitting is an error', () => {
  const ended = end();
  expect(ended.result).toMatchObject({
    outcome: 'error',
    reason: 'harness',
    message: 'the session ended without submitting',
  });
  expect(ended.endReason).toBe('failed');
});

test('a session that reported no tokens never counts as a success, whatever it submitted', () => {
  const none = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 };
  const ended = end({ reader: state({ spent: none }), submission: { outcome: 'done', output: {} } });
  expect(ended.result).toMatchObject({ outcome: 'error', reason: 'harness', message: 'the session reported no usage' });
});

test('a reader with no session id gives an empty one', () => {
  const { sessionId: _id, ...bare } = state();
  const ended = end({ reader: bare, submission: { outcome: 'done', output: {} } });
  expect(ended.result.sessionId).toBe('');
});
