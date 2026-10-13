// Turns the SDK's result message into the HarnessResult the port returns. Every error subtype ends in `error`, with the
// reason the port names and a message that is never empty. A success is `done` or `blocked` only when its structured
// output unwraps to one of those branches, and when the session spent some tokens (TASK-005).
import type { HarnessResult, Usage } from '../../ports/types';
import { unwrap } from './envelope';
import type { SDKResultMessage } from './sdk';

export interface ResultContext {
  readonly sessionId: string;
  /** What the session spent, from the tally. */
  readonly usage: Usage;
  /** The session's transcript, as renderTranscript gives it. */
  readonly transcript: string;
}

/** The SDK's own errors, when it gave any, as one text. */
const errorsOf = (message: SDKResultMessage): readonly string[] =>
  'errors' in message && Array.isArray(message.errors) ? message.errors : [];

function failed(
  message: SDKResultMessage,
  context: ResultContext,
  reason: 'harness' | 'budget_exceeded',
  text: string,
): HarnessResult {
  return {
    outcome: 'error',
    message: text,
    reason,
    sessionId: context.sessionId,
    usage: context.usage,
    transcript: context.transcript,
    raw: message,
  };
}

/** An error subtype: the two budgets name their limit, and every other subtype carries the SDK's errors. */
function errorOf(message: SDKResultMessage, context: ResultContext): HarnessResult {
  switch (message.subtype) {
    case 'error_max_turns':
      return failed(message, context, 'budget_exceeded', 'the session reached maxTurns and stopped (error_max_turns)');
    case 'error_max_budget_usd':
      return failed(
        message,
        context,
        'budget_exceeded',
        'the session reached maxUsd and stopped (error_max_budget_usd)',
      );
    default: {
      const detail = errorsOf(message).join('; ');
      return failed(
        message,
        context,
        'harness',
        detail === '' ? `the session ended with ${message.subtype}` : `${message.subtype}: ${detail}`,
      );
    }
  }
}

/** The result of a session that ended with `message`. */
export function resultOf(message: SDKResultMessage, context: ResultContext): HarnessResult {
  if (message.subtype !== 'success') return errorOf(message, context);
  const { usage } = context;
  const tokens = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens];
  if (tokens.every((count) => (count ?? 0) === 0)) {
    return failed(message, context, 'harness', 'the session spent no tokens, so it cannot have submitted an output');
  }
  if (message.structured_output === undefined) {
    return failed(message, context, 'harness', 'the session ended without structured output');
  }
  const submission = unwrap(message.structured_output);
  if (submission === undefined) {
    return failed(message, context, 'harness', 'the structured output is not a well-formed envelope');
  }
  const session = { sessionId: context.sessionId, usage, transcript: context.transcript, raw: message };
  return submission.outcome === 'done'
    ? { outcome: 'done', output: submission.output, ...session }
    : { outcome: 'blocked', reason: submission.reason, ...session };
}
