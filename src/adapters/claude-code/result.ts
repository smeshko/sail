// How a Claude Code session ended, as one HarnessResult. A submission is `done` or `blocked`; everything else is
// `error`, with the provider's text kept: an error subtype, an API error, no submission, no usage, no result, a throw or
// an abort. A session that reports no tokens never counts as a success, whatever it submitted (ADR-0008).
//
// STUB (TASK-004): the signature only, returning a wrong value.
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Budget, HarnessResult } from '../../ports/types';
import type { ReaderState } from './messages';

export interface ResultInput {
  /** The session's result message, when one came. */
  readonly result: SDKResultMessage | undefined;
  readonly reader: ReaderState;
  readonly budget: Budget;
  /** The request was aborted. */
  readonly aborted: boolean;
  /** What the session threw, when it threw. */
  readonly thrown?: { readonly error: unknown };
}

export interface Ended {
  /** The result, with an empty transcript: the harness renders it. */
  readonly result: HarnessResult;
  /** Why the session ended, in this harness's word, for its `harness:session_end`. */
  readonly endReason: string;
  /** The cost is the provider's estimate, not its bill (D10). */
  readonly costEstimate: boolean;
}

export function toHarnessResult(_input: ResultInput): Ended {
  return {
    result: { outcome: 'error', message: 'stub', sessionId: '', usage: { costUsd: 0 }, transcript: '', raw: null },
    endReason: '',
    costEstimate: false,
  };
}
