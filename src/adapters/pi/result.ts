// How a pi session ended, as one HarnessResult, in the words claude-code's result uses. A submission is `done` or
// `blocked`; everything else is `error`, with the provider's text kept: an overrun budget, an abort, a throw, a
// provider failure, no usage, no submission. A failure whose text is the usage limit is `usage_limit`, with `resetsAt`
// when the text gave one. A session that reports no tokens never counts as a success, whatever it submitted (ADR-0008).
import type { Budget, HarnessFailure } from '../../ports/types';
import type { ReaderState } from '../claude-code/messages';
import type { Ended } from '../claude-code/result';
import { limitText, resetsFromText } from '../claude-code/usage-limit';
import type { Submitted } from './submission';

export interface PiResultInput {
  readonly reader: ReaderState;
  /** What the `submit` tool kept, when it kept something. */
  readonly submission: Submitted | undefined;
  readonly budget: Budget;
  /** The request was aborted. */
  readonly aborted: boolean;
  /** The budget the session ran over, and was aborted for. */
  readonly over?: 'turns' | 'usd' | 'minutes' | undefined;
  /** What the session threw, when it threw. */
  readonly thrown?: { readonly error: unknown };
  /** The clock a reset time in the provider's text is read against. */
  readonly now?: Date;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function toHarnessResult(input: PiResultInput): Ended {
  const { reader, budget, submission } = input;
  const session = { sessionId: reader.sessionId ?? '', usage: reader.spent, transcript: '', raw: null };
  const failed = (
    message: string,
    endReason: string,
    reason: HarnessFailure = 'harness',
    resetsAt?: string,
  ): Ended => ({
    result: { outcome: 'error', message, reason, ...(resetsAt === undefined ? {} : { resetsAt }), ...session },
    endReason,
    costEstimate: false,
  });
  /** A failure that is the usage limit when `text` says so, with the reset time found. */
  const failure = (message: string, text: string): Ended => {
    if (!limitText(text)) return failed(message, 'failed');
    return failed(message, 'usage_limit', 'usage_limit', resetsFromText(text, input.now ?? new Date()));
  };

  if (input.over === 'turns') {
    return failed(`budget exceeded: maxTurns ${budget.maxTurns}`, 'max_turns', 'budget_exceeded');
  }
  if (input.over === 'usd') {
    return failed(`budget exceeded: maxUsd ${budget.maxUsd}`, 'max_budget_usd', 'budget_exceeded');
  }
  if (input.over === 'minutes') {
    return failed(`budget exceeded: maxMinutes ${budget.maxMinutes}`, 'max_minutes', 'budget_exceeded');
  }
  if (input.aborted) return failed('aborted', 'aborted');
  if (input.thrown !== undefined) {
    const text = messageOf(input.thrown.error);
    return failure(`pi: ${text}`, text);
  }
  const spent = reader.spent;
  const tokens =
    (spent.inputTokens ?? 0) + (spent.cacheReadTokens ?? 0) + (spent.cacheWriteTokens ?? 0) + (spent.outputTokens ?? 0);
  if (submission === undefined) {
    if (reader.failures.length > 0) {
      const said = reader.failures.join('; ');
      return failure(`the session failed: ${said}`, said);
    }
    return failed(tokens === 0 ? 'the session reported no usage' : 'the session ended without submitting', 'failed');
  }
  if (tokens === 0) return failed('the session reported no usage', 'failed');
  if (submission.outcome === 'done') {
    return {
      result: { outcome: 'done', output: submission.output, ...session },
      endReason: 'submitted',
      costEstimate: false,
    };
  }
  return {
    result: { outcome: 'blocked', reason: submission.reason, ...session },
    endReason: 'blocked',
    costEstimate: false,
  };
}
