// What the port tests share: capturing the events an adapter emits and stamping them as the bus would, so each one can
// be validated against sail.event.v1; reading a PortError out of a failed call; and a schema's issues as plain values.
import type { z } from 'zod';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import type { ProviderEvent } from '../../src/events/types';
import { PortError } from '../../src/ports/errors';

const RUN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const TS = '2026-09-29T09:00:00.000Z';

export interface Captured<E extends { type: string }> {
  readonly emit: (event: E) => void;
  readonly events: E[];
  /** Each event in a synthetic envelope: `seq` from 1, a fixed `ts`, the golden run id, and `key` when one is given. */
  stamped(key?: string): Record<string, unknown>[];
}

export function captureEvents<E extends { type: string } = ProviderEvent>(): Captured<E> {
  const events: E[] = [];
  return {
    emit: (event) => events.push(event),
    events,
    stamped: (key) =>
      events.map(({ type, ...payload }, i) => ({
        seq: i + 1,
        ts: TS,
        type,
        runId: RUN_ID,
        ...(key === undefined ? {} : { key }),
        ...payload,
      })),
  };
}

/** The events with each non-negative `durationMs` replaced by `'ms'`, so a test can compare them whole. */
export function timed(events: readonly object[]): Record<string, unknown>[] {
  return events.map((event) => {
    const copy: Record<string, unknown> = { ...event };
    if (typeof copy.durationMs === 'number' && copy.durationMs >= 0) copy.durationMs = 'ms';
    return copy;
  });
}

/** Every way the stamped events break sail.event.v1, as `#<seq> <type> <issue>`. */
export function eventIssues(stamped: readonly Record<string, unknown>[]): string[] {
  return stamped.flatMap((event) =>
    validateDocument('sail.event.v1', event).map((issue) => `#${event.seq} ${event.type} ${formatIssue(issue)}`),
  );
}

/** What `promise` rejected with, or `'resolved'` when it resolved. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error;
  }
}

/** What `fn` threw, or `'returned'` when it returned. */
export function caught(fn: () => unknown): unknown {
  try {
    fn();
    return 'returned';
  } catch (error) {
    return error;
  }
}

/** A PortError's port, op and code, or anything else as a string. */
export function portFailure(error: unknown): { port: string; op: string; code: string } | string {
  return error instanceof PortError ? { port: error.port, op: error.op, code: error.code } : String(error);
}

/** A thrown value's message, or the value as a string when it isn't an Error. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ParseIssue {
  /** The issue's path, dot-joined, and `''` for the value itself. */
  path: string;
  message: string;
}

/** Every way `value` breaks `schema`, or `[]` when it parses. */
export function parseIssues(schema: z.ZodType, value: unknown): ParseIssue[] {
  const result = schema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** What `schema` parses `value` into, or its issues when it doesn't parse. */
export function parsed(schema: z.ZodType, value: unknown): unknown {
  const result = schema.safeParse(value);
  return result.success ? result.data : { issues: parseIssues(schema, value) };
}
