// Maps one SDK message to the harness events it gives. STUB (TASK-002): the signatures are final, the bodies are not.
import type { HarnessEvent } from '../../ports/harness';
import type { SDKMessage } from './sdk';

/** What the mapper carries from one message to the next. */
export interface MapState {
  readonly key: string;
  readonly model: string;
  readonly now: () => number;
  /** Tool calls started and not yet ended, by call id, with the time each started. */
  readonly open: Map<string, number>;
  /** Whether the session has started. */
  started: boolean;
}

/** A state for one call's session. */
export function startMapping(key: string, model: string, now: () => number): MapState {
  return { key, model, now, open: new Map(), started: false };
}

/** The events of one SDK message, in the message's order. Stub: gives none. */
export function mapMessage(_message: SDKMessage, _state: MapState): HarnessEvent[] {
  return [];
}
