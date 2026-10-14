// A session's transcript, which the agent kind keeps as `session.log`: one block per event worth reading, in order,
// and how the session ended. It reads only sail's own events, so any harness can render its sessions with it.
//
// STUB (TASK-005): the signature only, returning a wrong value.
import type { HarnessEvent } from '../../ports/harness';
import type { HarnessResult } from '../../ports/types';

export interface TranscriptEnd {
  readonly outcome: HarnessResult['outcome'];
  /** A blocked session's reason, or an error's message. */
  readonly message?: string;
  /** The usage is the provider's estimate, not its bill (D10). */
  readonly costEstimate?: boolean;
}

export function renderTranscript(_events: readonly HarnessEvent[], _end?: TranscriptEnd): string {
  return '';
}
