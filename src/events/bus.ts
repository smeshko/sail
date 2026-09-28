// The event bus: numbers, timestamps and stamps each event with the run's id, then hands it synchronously to every
// consumer. A consumer that throws is reported as an `error:consumer` event, and `emit` never throws.
//
// The synchronous fan-out is the prototype's event bus. What isn't: its `catch {}`, which swallowed a consumer's
// throw; its `init()` and `dispose()`, since a consumer here holds nothing open; and its millisecond `timestamp`,
// which `ts` replaces with ISO 8601.
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
  /**
   * Stamps `event`, delivers it to every consumer, and returns it stamped. Never throws. Called during a delivery, it
   * returns before its event is delivered, since that waits for the current one.
   */
  emit(event: NewEvent): SailEvent;
}

/** A thrown value's message. Anything can be thrown, including a value `String()` rejects, like `Object.create(null)`. */
function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "a thrown value String() can't convert";
  }
}

function writeToStderr(error: unknown, consumer: Consumer, event: SailEvent): void {
  process.stderr.write(`sail: consumer ${consumer.name} failed on ${event.type} #${event.seq}: ${messageOf(error)}\n`);
}

export function createBus(options: BusOptions): EventBus {
  const { runId, consumers, now, unreported = writeToStderr } = options;
  let seq = options.firstSeq;

  // The envelope comes first, then the key, then the payload, so a written line reads in that order. The envelope is
  // spread again last, since it is the bus's: an open payload's `seq`, `ts` or `runId` must not replace it.
  function stamp(event: NewEvent): SailEvent {
    const { type, ...rest } = event;
    const { key, ...payload } = rest as { key?: string };
    const envelope = { seq: seq++, ts: (now?.() ?? new Date()).toISOString(), type, runId };
    return { ...envelope, ...(key === undefined ? {} : { key }), ...payload, ...envelope } as SailEvent;
  }

  /** Stamped events waiting for the one being delivered to reach every consumer. */
  const queue: SailEvent[] = [];
  let delivering = false;

  // A failure is reported once every consumer has the event. A failure on an `error:consumer` goes to `unreported`
  // rather than becoming another report, so the stream can't loop.
  function deliver(stamped: SailEvent): void {
    const failures: { consumer: Consumer; error: unknown }[] = [];
    for (const consumer of consumers) {
      try {
        consumer.onEvent(stamped);
      } catch (error) {
        failures.push({ consumer, error });
      }
    }
    for (const { consumer, error } of failures) {
      if (stamped.type === 'error:consumer') {
        try {
          unreported(error, consumer, stamped);
        } catch {
          // The last resort failed too, and nothing is left to tell. `emit` still doesn't throw.
        }
      } else
        emit({
          type: 'error:consumer',
          consumer: consumer.name,
          failed: { seq: stamped.seq, type: stamped.type },
          message: messageOf(error),
        });
    }
  }

  // An event emitted during a delivery, by a consumer or as a failure's report, waits in the queue until every
  // consumer has the one being delivered. So each consumer sees the stream in `seq` order.
  function emit(event: NewEvent): SailEvent {
    const stamped = stamp(event);
    queue.push(stamped);
    if (delivering) return stamped;
    delivering = true;
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) deliver(next);
    } finally {
      delivering = false;
    }
    return stamped;
  }

  return { emit };
}
