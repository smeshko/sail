// How a Claude Code session ended, as one HarnessResult. A submission is `done` or `blocked`; everything else is
// `error`, with the provider's text kept: an error subtype, an API error, no submission, no usage, no result, a throw or
// an abort. A session that met the usage limit (a rejected rate limit event, a `rate_limit` error, or the limit's own
// text) is `usage_limit`, with `resetsAt` when the SDK or the text gave one. A session that reports no tokens never counts as a success, whatever it submitted (ADR-0008).
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Budget, HarnessFailure, HarnessResult } from '../../ports/types';
import type { ReaderState } from './messages';
import { resultTokens } from './messages';
import { readSubmission } from './submission';
import { limitText, resetsFromText } from './usage-limit';

export interface ResultInput {
  /** The session's result message, when one came. */
  readonly result: SDKResultMessage | undefined;
  readonly reader: ReaderState;
  readonly budget: Budget;
  /** The request was aborted. */
  readonly aborted: boolean;
  /** The session ran out of its minutes, and was aborted for it (D6). */
  readonly overMinutes?: boolean;
  /** What the session threw, when it threw. */
  readonly thrown?: { readonly error: unknown };
  /** The clock a reset time in the provider's text is read against. */
  readonly now?: Date;
}

export interface Ended {
  /** The result, with an empty transcript: the harness renders it. */
  readonly result: HarnessResult;
  /** Why the session ended, in this harness's word, for its `harness:session_end`. */
  readonly endReason: string;
  /** The cost is the provider's estimate, not its bill (D10). */
  readonly costEstimate: boolean;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Bedrock and Vertex report cost as an estimate. */
const isEstimate = (result: SDKResultMessage | undefined): boolean =>
  Object.values(result?.modelUsage ?? {}).some((model) => model.provider === 'bedrock' || model.provider === 'vertex');

export function toHarnessResult(input: ResultInput): Ended {
  const { result, reader, budget } = input;
  const costEstimate = isEstimate(result);
  const raw = result === undefined ? null : costEstimate ? { ...result, costEstimate: true } : result;
  const session = { sessionId: reader.sessionId ?? result?.session_id ?? '', usage: reader.spent, transcript: '', raw };
  const failed = (
    message: string,
    endReason: string,
    reason: HarnessFailure = 'harness',
    resetsAt?: string,
  ): Ended => ({
    result: { outcome: 'error', message, reason, ...(resetsAt === undefined ? {} : { resetsAt }), ...session },
    endReason,
    costEstimate,
  });
  /** A failure that is the usage limit when the reader saw it or `text` says it, with the reset time found. */
  const failure = (message: string, text: string): Ended => {
    if (reader.limited === undefined && !limitText(text)) return failed(message, 'failed');
    const resetsAt = reader.limited?.resetsAt ?? resetsFromText(text, input.now ?? new Date());
    return failed(message, 'usage_limit', 'usage_limit', resetsAt);
  };

  if (input.overMinutes === true) {
    return failed(`budget exceeded: maxMinutes ${budget.maxMinutes}`, 'max_minutes', 'budget_exceeded');
  }
  if (input.aborted) return failed('aborted', 'aborted');
  if (input.thrown !== undefined) {
    const text = messageOf(input.thrown.error);
    return failure(`claude-code: ${text}`, text);
  }
  if (result === undefined) return failed('the session ended without a result', 'failed');

  /** `text`, then what an error result said after a colon, when it said anything. */
  const saying = (text: string, errors: readonly string[]) => {
    const said = errors.join('; ');
    return said === '' ? text : `${text}: ${said}`;
  };
  switch (result.subtype) {
    case 'error_max_turns':
      return failed(
        saying(`budget exceeded: maxTurns ${budget.maxTurns}`, result.errors),
        'max_turns',
        'budget_exceeded',
      );
    case 'error_max_budget_usd':
      return failed(
        saying(`budget exceeded: maxUsd ${budget.maxUsd}`, result.errors),
        'max_budget_usd',
        'budget_exceeded',
      );
    case 'error_max_structured_output_retries':
      return failed(saying('the output never matched its schema', result.errors), 'max_structured_output_retries');
    case 'error_during_execution':
      return failed(saying('the session failed during execution', result.errors), 'failed');
  }

  if (result.is_error) {
    const said = [result.result, ...reader.failures.filter((text) => text !== result.result)].filter(
      (text) => text !== '',
    );
    return failure(`the session failed${said.length === 0 ? '' : `: ${said.join('; ')}`}`, said.join('; '));
  }
  const tokens = resultTokens(result);
  if (tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output === 0) {
    return failed('the session reported no usage', 'failed');
  }
  if (result.structured_output === undefined) return failed('the session ended without submitting', 'failed');
  const submission = readSubmission(result.structured_output);
  if ('unreadable' in submission) return failed(submission.unreadable, 'failed');
  if (submission.outcome === 'done') {
    return { result: { outcome: 'done', output: submission.output, ...session }, endReason: 'submitted', costEstimate };
  }
  return { result: { outcome: 'blocked', reason: submission.reason, ...session }, endReason: 'blocked', costEstimate };
}
