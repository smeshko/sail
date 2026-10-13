// Counts a session's usage once per assistant message, by message id. STUB (TASK-003): the signatures are final, the
// bodies are not.
import type { HarnessEvent } from '../../ports/harness';
import type { Usage } from '../../ports/types';
import type { SDKAssistantMessage, SDKResultMessage } from './sdk';

export interface Tally {
  /** The cumulative `usage:update` for a message whose id is new, or nothing for one already counted. */
  onAssistant(message: SDKAssistantMessage): HarnessEvent | undefined;
  /** The final `usage:update`, carrying the session's total cost. */
  onResult(message: SDKResultMessage): HarnessEvent | undefined;
  /** What the session spent so far. */
  usage(): Usage;
}

/** A tally for the call `key`. Stub: counts nothing. */
export function createTally(_key: string): Tally {
  return {
    onAssistant: () => undefined,
    onResult: () => undefined,
    usage: () => ({ costUsd: 0 }),
  };
}
