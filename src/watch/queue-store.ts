// A watched workflow's queue: `.sail-runs/queue/<workflow>/queue.json`, beside its queue event stream.
//
// - The watcher alone writes `queue.json`, through this store, which keeps the queue in memory and replaces the whole
//   file atomically on each change. Anything else asks for a change by dropping a command file (`inbox.ts`).
// - A change is made on a copy, which becomes the queue only once it is on disk. A write that throws leaves the store
//   holding what `queue.json` holds: the old queue when the write failed before its rename, and the new one when only
//   the directory's sync after it failed. So the next change never writes an old queue back over a newer one. When
//   `queue.json` can't be read back either, no change is made until it can.
// - Items are known by their dedup key. A key whose item is done may be queued again: the ticket system is the memory
//   of what was started (ADR-0015), and a ticket moved back to unstarted is a deliberate re-run.
// - A parked item stays in `items` with its reason, so a person can see it, and its key stays taken until a person
//   requeues or drops it (13.3).
// - A dispatch is two steps: `dispatched()` counts the attempt and names the run before any process exists, and
//   `spawned()` adds the process's pid once it does, emitting `queue:dispatched`. An item a re-check finds ineligible
//   is dropped: it leaves `items`, and a later poll may queue it again.
// - `skippedLeased()`, `watched()` and `unwatched()` only emit their events: none of them changes `queue.json`.
// - Every event the store emits is handed to `onEvent` once it is appended, in order: the watcher's terminal lines. A
//   hook that throws is ignored, so the terminal never breaks the queue.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { replaceFile } from '../engine/durable';
import type { QueueEvent } from '../events/types';
import { PORT_ERROR_CODES, type PortErrorCode } from '../ports/errors';
import type { Ticket } from '../ports/types';
import { openQueueStream } from './queue-events';

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
  /** The process of that run, once it was spawned. */
  pid: z.number().int().positive().optional(),
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
  return `${source.kind}:${source.ticketKey}`;
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
  /** Records the pid of the dispatched item's process, and emits `queue:dispatched`. An item not dispatched throws. */
  spawned(key: string, pid: number): void;
  /** Takes the item out of the queue, and emits `queue:dropped` with the reason. An unknown key throws. */
  drop(key: string, reason: string): void;
  /** Emits `queue:skipped_leased`: the due item waits, since run `heldBy` holds `branch`. The queue is unchanged. */
  skippedLeased(key: string, branch: string, heldBy: string): void;
  /** Emits `watch:added`: watcher `pid` watches the workflow now. The queue is unchanged. */
  watched(watch: { pid: number; everyMs: number; maxConcurrentRuns: number }): void;
  /** Emits `watch:removed`: watcher `pid` no longer watches the workflow. The queue is unchanged. */
  unwatched(pid: number): void;
  done(key: string): void;
  /** Records a failed attempt: the item retries later, or is parked once it has had `maxAttempts`. */
  failed(key: string, reason: string): 'retry' | 'parked';
  /** Records a poll that succeeded, which clears the failures and the pause. */
  polled(poll: { kind: 'ticket'; found: number; added: number; durationMs: number }): void;
  /** Records a failed poll: a refusal of the credentials pauses the workflow, and any other failure clears the pause. */
  pollFailed(failure: PollFailure): void;
}

export interface OpenQueueOptions {
  runsDir: string;
  workflow: string;
  /** The label the workflow polls for. */
  label: string;
  now: () => Date;
  policy?: QueuePolicy;
  /** Hears each event the store emits, once it is appended. One that throws is ignored. */
  onEvent?: (event: QueueEvent) => void;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads `path`, or why it can't be read: it won't parse, or isn't a queue. */
function readQueueFile(path: string): QueueFile | { refused: string } {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { refused: `${path} can't be read: ${messageOf(error)}` };
  }
  const parsed = QueueFile.safeParse(data);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  return { refused: `${path} is not a queue: ${[issue?.path.join('.'), issue?.message].filter(Boolean).join(' ')}` };
}

/** Opens `workflow`'s queue, an empty one when it has no `queue.json` yet. One that can't be read refuses. */
export function openQueue(options: OpenQueueOptions): QueueStore | { refused: string } {
  const { workflow, label, now } = options;
  const policy = options.policy ?? DEFAULT_QUEUE_POLICY;
  const dir = queueDir(options.runsDir, workflow);
  const path = join(dir, QUEUE_FILE);
  mkdirSync(dir, { recursive: true });
  let queue: QueueFile;
  if (existsSync(path)) {
    const read = readQueueFile(path);
    if ('refused' in read) return read;
    queue = { ...read, polling: { ...read.polling, label } };
  } else {
    queue = { version: 1, workflow, updatedAt: now().toISOString(), polling: { label, failures: 0 }, items: [] };
  }
  const opened = openQueueStream(dir, now);
  if ('refused' in opened) return opened;
  const stream = opened;

  /** Set when a write threw and queue.json couldn't be read back: what it holds is unknown until it can be. */
  let unsure = false;
  /** Makes what queue.json holds the queue, or says why it can't be read. */
  const adopt = (): string | undefined => {
    const onDisk = readQueueFile(path);
    if ('refused' in onDisk) return onDisk.refused;
    queue = onDisk;
    return undefined;
  };
  /** Makes the change on a copy, writes it, and only then makes it the queue. */
  const change = <T>(make: (next: QueueFile) => T): T => {
    if (unsure) {
      const refused = adopt();
      if (refused !== undefined) throw new Error(refused);
      unsure = false;
    }
    const next = structuredClone(queue);
    const result = make(next);
    next.updatedAt = now().toISOString();
    try {
      replaceFile(path, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      // No queue.json means the write never reached it, and the queue is still the one in memory.
      unsure = existsSync(path) && adopt() !== undefined;
      throw error;
    }
    queue = next;
    return result;
  };
  const find = (next: QueueFile, key: string): QueueItem => {
    const item = next.items.find((each) => each.dedupKey === key);
    if (item === undefined) throw new Error(`${workflow}'s queue has no item ${key}`);
    return item;
  };
  const isDue = (item: QueueItem, at: number) =>
    item.state === 'queued' || (item.state === 'failed' && Date.parse(item.retryAt ?? '') <= at);

  return {
    snapshot: () => structuredClone(queue),
    add(tickets) {
      const added = change((next) => {
        const queued: QueueItem[] = [];
        for (const ticket of tickets) {
          const key = dedupKey({ kind: 'ticket', ticketKey: ticket.ticketKey });
          const taken = next.items.find((item) => item.dedupKey === key);
          if (taken !== undefined && taken.state !== 'done') continue;
          if (taken !== undefined) next.items.splice(next.items.indexOf(taken), 1);
          const item: QueueItem = {
            dedupKey: key,
            source: { kind: 'ticket', ticketKey: ticket.ticketKey },
            title: ticket.title,
            url: ticket.url,
            state: 'queued',
            attempts: 0,
            addedAt: now().toISOString(),
          };
          next.items.push(item);
          queued.push(item);
        }
        return queued;
      });
      stream.emitAll(
        added.map((item) => ({
          type: 'queue:item_added' as const,
          workflow,
          dedupKey: item.dedupKey,
          source: item.source,
          title: item.title,
        })),
      );
      return added.length;
    },
    due() {
      const at = now().getTime();
      return structuredClone(queue.items.filter((item) => isDue(item, at))).sort(
        (a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt),
      );
    },
    dispatched(key, runId) {
      change((next) => {
        const item = find(next, key);
        item.state = 'dispatched';
        item.attempts += 1;
        item.runId = runId;
        delete item.retryAt;
      });
    },
    spawned(_key, _pid) {},
    drop(_key, _reason) {},
    skippedLeased(_key, _branch, _heldBy) {},
    watched(_watch) {},
    unwatched(_pid) {},
    done(key) {
      change((next) => {
        const item = find(next, key);
        item.state = 'done';
        item.finishedAt = now().toISOString();
        delete item.retryAt;
        // Oldest finished first: the sort is stable, so items finished together keep their order.
        const done = next.items
          .filter((each) => each.state === 'done')
          .sort((a, b) => Date.parse(a.finishedAt ?? '') - Date.parse(b.finishedAt ?? ''));
        const dropped = new Set(done.slice(0, Math.max(0, done.length - policy.doneKept)));
        next.items = next.items.filter((each) => !dropped.has(each));
      });
    },
    failed(key, reason) {
      const item = change((next) => {
        const failing = find(next, key);
        failing.reason = reason;
        if (failing.attempts >= policy.maxAttempts) {
          failing.state = 'parked';
          failing.finishedAt = now().toISOString();
          delete failing.retryAt;
        } else {
          const delays = policy.retryDelaysMs;
          const delay = delays[Math.min(Math.max(0, failing.attempts - 1), delays.length - 1)] ?? 0;
          failing.state = 'failed';
          failing.retryAt = new Date(now().getTime() + delay).toISOString();
        }
        return { ...failing };
      });
      if (item.state === 'failed') return 'retry';
      stream.emit({ type: 'queue:parked', workflow, dedupKey: key, attempts: item.attempts, reason });
      return 'parked';
    },
    polled(poll) {
      change((next) => {
        next.polling.failures = 0;
        delete next.polling.paused;
        next.polling.lastPolledAt = now().toISOString();
      });
      stream.emit({ type: 'queue:polled', workflow, label: queue.polling.label, ...poll });
    },
    pollFailed(failure) {
      change((next) => {
        if (failure.paused) {
          const { port, adapter, code, message } = failure;
          next.polling.paused = {
            port,
            adapter,
            ...(code === undefined ? {} : { code }),
            message,
            at: now().toISOString(),
          };
        } else {
          // The provider no longer refuses the credentials, it fails some other way: the workflow is back on the
          // backoff, so the file says so. A refusal on a later poll pauses it again.
          delete next.polling.paused;
          next.polling.failures += 1;
        }
      });
      stream.emit({ type: 'queue:error', workflow, ...failure });
    },
  };
}
