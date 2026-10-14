// What the queue tests share: a clock they move by hand, tickets as an adapter answers them, and a queue's events file
// read back line by line, with every line checked against `sail.event.v1`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import type { Ticket, TicketState } from '../../src/ports/types';

export interface ManualClock {
  (): Date;
  /** Moves the clock on by `ms`. */
  advance(ms: number): void;
}

/** A clock that reads `start` until it is moved. */
export function manualClock(start: string): ManualClock {
  let at = Date.parse(start);
  return Object.assign(() => new Date(at), {
    advance(ms: number) {
      at += ms;
    },
  });
}

export const TODO: TicketState = { type: 'unstarted', name: 'Todo' };

/** A ticket as an adapter answers it: designated with `sail` and unstarted unless `fields` say otherwise. */
export function ticket(ticketKey: string, fields: Partial<Ticket> = {}): Ticket {
  return {
    ticketKey,
    title: `Ticket ${ticketKey}`,
    url: `fake://tickets/${ticketKey}`,
    description: '',
    state: TODO,
    labels: ['sail'],
    comments: [],
    links: [],
    attachments: [],
    raw: { ticketKey },
    ...fields,
  };
}

/** Every line of `<dir>/events.ndjson`, parsed. None when the file is missing. */
export function queueEvents(dir: string): Record<string, unknown>[] {
  const path = join(dir, 'events.ndjson');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/** Each way a line of `<dir>/events.ndjson` breaks `sail.event.v1`, as `<line>: <issue>`. Empty when all are valid. */
export function queueEventIssues(dir: string): string[] {
  return queueEvents(dir).flatMap((event, index) =>
    validateDocument('sail.event.v1', event).map((issue) => `${index + 1}: ${formatIssue(issue)}`),
  );
}
