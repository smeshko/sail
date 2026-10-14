// A watched workflow's queue: `.sail-runs/queue/<workflow>/queue.json`, beside its queue event stream.
// Stubbed for queue-store-and-polling: TASK-003 writes the store.
import { join } from 'node:path';
import { z } from 'zod';
import { PORT_ERROR_CODES, type PortErrorCode } from '../ports/errors';
import type { Ticket } from '../ports/types';

export const QUEUE_DIR = 'queue';
export const QUEUE_FILE = 'queue.json';

/** Where `workflow`'s queue lives under `.sail-runs/`. */
export function queueDir(runsDir: string, workflow: string): string {
  return join(runsDir, QUEUE_DIR, workflow);
}

export const QueueSource = z.strictObject({ kind: z.literal('ticket'), ticketKey: z.string().min(1) });
export type QueueSource = z.infer<typeof QueueSource>;

export const QueueItemState = z.enum(['queued', 'dispatched', 'done', 'failed', 'parked']);
export type QueueItemState = z.infer<typeof QueueItemState>;

export const QueueItem = z.strictObject({
  dedupKey: z.string(),
  source: QueueSource,
  title: z.string(),
  url: z.string(),
  state: QueueItemState,
  /** How many times it was dispatched. */
  attempts: z.number().int().min(0),
  addedAt: z.string(),
  /** When a failed item is due again. */
  retryAt: z.string().optional(),
  /** The run its last dispatch started. */
  runId: z.string().optional(),
  /** Why it last failed. */
  reason: z.string().optional(),
  finishedAt: z.string().optional(),
});
export type QueueItem = z.infer<typeof QueueItem>;

const PollPort = z.enum(['ticketSource', 'codeHost']);

export const QueueFile = z.strictObject({
  version: z.literal(1),
  workflow: z.string(),
  updatedAt: z.string(),
  polling: z.strictObject({
    label: z.string(),
    /** Failed polls since the last one that succeeded. */
    failures: z.number().int().min(0),
    lastPolledAt: z.string().optional(),
    /** Set when the provider refused the credentials: timed polls stop until a poll succeeds. */
    paused: z
      .strictObject({
        port: PollPort,
        adapter: z.string(),
        code: z.enum(PORT_ERROR_CODES).optional(),
        message: z.string(),
        at: z.string(),
      })
      .optional(),
  }),
  items: z.array(QueueItem),
});
export type QueueFile = z.infer<typeof QueueFile>;

export interface QueuePolicy {
  /** Dispatches an item gets before it is parked. */
  maxAttempts: number;
  /** The wait before a failed item is due again, by attempt. The last repeats. */
  retryDelaysMs: readonly number[];
  /** The wait after a failed poll, by consecutive failure. The last repeats, and none is shorter than `every`. */
  pollBackoffMs: readonly number[];
  /** How many done items are kept. */
  doneKept: number;
}

/** The prototype's numbers (DECISIONS D6). */
export const DEFAULT_QUEUE_POLICY: QueuePolicy = {
  maxAttempts: 2,
  retryDelaysMs: [5 * 60_000, 20 * 60_000],
  pollBackoffMs: [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000],
  doneKept: 100,
};

/** The key a queue item is known by: `ticket:<ticket key>`. */
export function dedupKey(source: QueueSource): string {
  return source.ticketKey;
}

/** A poll that failed, as `pollFailed()` records it. */
export interface PollFailure {
  port: 'ticketSource' | 'codeHost';
  adapter: string;
  code?: PortErrorCode;
  message: string;
  /** True when the provider refused the credentials. */
  paused: boolean;
  /** When the next poll is, for a poll that isn't paused. */
  retryInMs?: number;
}

export interface QueueStore {
  /** A copy of the queue as `queue.json` holds it. */
  snapshot(): QueueFile;
  /** Queues each ticket whose key isn't taken, and gives how many it queued. */
  add(tickets: readonly Ticket[]): number;
  /** The items a dispatch may start: queued ones, and failed ones past their `retryAt`, oldest first. */
  due(): QueueItem[];
  /** Records a dispatch of the item, which counts an attempt. */
  dispatched(key: string, runId: string): void;
  done(key: string): void;
  /** Records a failed attempt: the item retries later, or is parked once it has had `maxAttempts`. */
  failed(key: string, reason: string): 'retry' | 'parked';
  /** Records a poll that succeeded, which clears the failures and the pause. */
  polled(poll: { kind: 'ticket'; found: number; added: number; durationMs: number }): void;
  pollFailed(failure: PollFailure): void;
}

export interface OpenQueueOptions {
  runsDir: string;
  workflow: string;
  /** The label the workflow polls for. */
  label: string;
  now: () => Date;
  policy?: QueuePolicy;
}

/** Opens `workflow`'s queue, an empty one when it has no `queue.json` yet. One that can't be read refuses. */
export function openQueue(options: OpenQueueOptions): QueueStore | { refused: string } {
  const { workflow, label } = options;
  const empty: QueueFile = { version: 1, workflow, updatedAt: '', polling: { label, failures: 0 }, items: [] };
  return {
    snapshot: () => structuredClone(empty),
    add: () => 0,
    due: () => [],
    dispatched() {},
    done() {},
    failed: () => 'retry',
    polled() {},
    pollFailed() {},
  };
}
