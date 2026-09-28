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
  /** Stamps `event`, delivers it to every consumer, and returns it stamped. Never throws. */
  emit(event: NewEvent): SailEvent;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function writeToStderr(error: unknown, consumer: Consumer, event: SailEvent): void {
  process.stderr.write(`sail: consumer ${consumer.name} failed on ${event.type} #${event.seq}: ${messageOf(error)}\n`);
}

export function createBus(options: BusOptions): EventBus {
  const { runId, consumers, now, unreported = writeToStderr } = options;
  let seq = options.firstSeq;

  // The envelope comes first, then the key, then the payload, so a written line reads in that order.
  function stamp(event: NewEvent): SailEvent {
    const { type, ...rest } = event;
    const { key, ...payload } = rest as { key?: string };
    const envelope = { seq: seq++, ts: (now?.() ?? new Date()).toISOString(), type, runId };
    return { ...envelope, ...(key === undefined ? {} : { key }), ...payload } as SailEvent;
  }

  // Every consumer gets the event before any failure is reported, so each one sees the stream in `seq` order. A
  // failure on an `error:consumer` goes to `unreported` rather than becoming another report, so the stream can't loop.
  function publish(event: NewEvent): SailEvent {
    const stamped = stamp(event);
    const failures: { consumer: Consumer; error: unknown }[] = [];
    for (const consumer of consumers) {
      try {
        consumer.onEvent(stamped);
      } catch (error) {
        failures.push({ consumer, error });
      }
    }
    for (const { consumer, error } of failures) {
      if (stamped.type === 'error:consumer') unreported(error, consumer, stamped);
      else
        publish({
          type: 'error:consumer',
          consumer: consumer.name,
          failed: { seq: stamped.seq, type: stamped.type },
          message: messageOf(error),
        });
    }
    return stamped;
  }

  return { emit: publish };
}
