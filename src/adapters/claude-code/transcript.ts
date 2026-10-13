// Renders a session's events as the transcript session.log holds. STUB (TASK-005): the signature is final, the body is
// not.
import type { HarnessEvent } from '../../ports/harness';

/** A provider whose cost is an estimate, which the header then says. */
export type EstimatedProvider = 'bedrock' | 'vertex';

/** One line per message in event order, usage lines last. Stub: an empty transcript. */
export function renderTranscript(
  _events: readonly HarnessEvent[],
  _options: { provider?: EstimatedProvider } = {},
): string {
  return '';
}
