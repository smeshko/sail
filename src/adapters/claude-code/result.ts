// Turns the SDK's result message into the HarnessResult the port returns. STUB (TASK-005): the signature is final, the
// body is not.
import type { HarnessResult, Usage } from '../../ports/types';
import type { SDKResultMessage } from './sdk';

export interface ResultContext {
  readonly sessionId: string;
  /** What the session spent, from the tally. */
  readonly usage: Usage;
  /** The session's transcript, as renderTranscript gives it. */
  readonly transcript: string;
}

/** The result of a session that ended with `message`. Stub: every session is an error with no message. */
export function resultOf(message: SDKResultMessage, context: ResultContext): HarnessResult {
  return {
    outcome: 'error',
    message: '',
    reason: 'harness',
    sessionId: context.sessionId,
    usage: context.usage,
    transcript: context.transcript,
    raw: message,
  };
}
