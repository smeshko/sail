// The event bus: numbers, timestamps and stamps each event with the run's id, then hands it synchronously to every
// consumer. A consumer that throws is reported as an `error:consumer` event, and `emit` never throws.
import type { Consumer, NewEvent, SailEvent } from './types';

export interface BusOptions {
  runId: string;
  /** 1 for a fresh run, `nextSeq()` on a resume. */
  firstSeq: number;
  consumers: readonly Consumer[];
  now?: () => Date;
  /** Where a consumer's throw on an `error:consumer` event goes. Stderr by default. */
  unreported?: (error: unknown, consumer: Consumer, event: SailEvent) => void;
}

export interface EventBus {
  /** Stamps `event`, delivers it to every consumer, and returns it stamped. Never throws. */
  emit(event: NewEvent): SailEvent;
}

// biome-ignore lint/correctness/noUnusedFunctionParameters: a stub until TASK-002 stamps and delivers
export function createBus(options: BusOptions): EventBus {
  return { emit: (event) => ({ seq: 0, ts: '', runId: '', ...event }) as SailEvent };
}
