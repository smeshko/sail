// Builds the SDK's options for one session. STUB (TASK-004): the signatures and the contract text's name are final; the
// bodies are not. The permission gate is phase 7.3's: this module sets no hook and no canUseTool.
import type { HarnessRequest } from '../../ports/harness';
import type { Options } from './sdk';

/** The text appended to the Claude Code system prompt. Stub: empty. */
export const SUBMIT_CONTRACT = '';

/** A zero dollar budget is refused before any session starts. */
export interface Refusal {
  readonly reason: 'budget_exceeded';
  readonly message: string;
}

export type SessionPlan = { readonly options: Options } | { readonly refused: Refusal };

export interface SessionDeps {
  /** The environment the session is started from: only its allowlisted names are forwarded. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly abortController: AbortController;
}

/** The SDK's options for `request`, or a refusal. Stub: refuses every request with an empty message. */
export function sessionOptions(_request: HarnessRequest, _deps: SessionDeps): SessionPlan {
  return { refused: { reason: 'budget_exceeded', message: '' } };
}
