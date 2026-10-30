// A watched workflow's queue: `.sail-runs/queue/<workflow>/queue.json`, beside its queue event stream.
//
// - The watcher alone writes `queue.json`, through this store, which keeps the queue in memory and replaces the whole
//   file atomically on each change. Anything else asks for a change by dropping a command file (`inbox.ts`).
// - A change is made on a copy, which becomes the queue only once it is on disk. A write that throws leaves the store
//   holding what `queue.json` holds: the old queue when the write failed before its rename, and the new one when only
//   the directory's sync after it failed. So the next change never writes an old queue back over a newer one. When
//   `queue.json` can't be read back either, no change is made until it can.
// - Items are known by their dedup key. A ticket key whose item is done may be queued again: the ticket system is the
//   memory of what was started (ADR-0015), and a ticket moved back to unstarted is a deliberate re-run. A pull request's
//   key carries its head sha, so a done one stays taken while the item is kept: the same sha is never reviewed twice.
//   Only the same full sha keeps it: a done item at another sha that shares its first 7 is replaced.
// - Pending items (queued, and failed awaiting a retry) are kept in queue order in `items`, and `due()` reads them in
//   that order: by the ticket's priority (urgent, high, medium, low, none), oldest first within one. A pull request
//   counts as none. An unmoved pending item goes before the first unmoved pending item dispatched after it, on add, on
//   a priority change a re-add finds, on a retry and on a requeue. A queue.json without priorities keeps the order it
//   has, which is the order of `addedAt`.
// - A parked item stays in `items` with its reason, so a person can see it, and its key stays taken until a person
//   requeues or drops it. `parked()` parks whatever the attempts: a stopped run's item is a person's decision, not a
//   failure to retry. `requeue()` puts a parked or failed item back as queued with no attempts.
// - A forced item, added with `--force`, says so in `forced`: its first dispatch skips the re-check of designation and
//   state, and a retry is re-checked. `requeue()` clears its attempts, so the dispatch after it is a first one again.
//   An unforced item whose ticket its own failed run claimed passes the re-check too, and its run starts forced.
// - A dispatch is two steps: `dispatched()` counts the attempt and names the run before any process exists, and
//   `spawned()` adds the process's pid once it does, emitting `queue:dispatched`. An item a re-check finds ineligible
//   (a ticket its own failed run claimed is not) is dropped: it leaves `items`, and a later poll may queue it again.
// - A dispatched item whose run the watcher found alive is `adopted()`, and one whose run it resumed is `resumed()`: each
//   records the pid the run is alive as now, and emits `run:adopted` or `run:resumed`.
// - A run that hit the usage limit, or could not reach a provider, holds the workflow's dispatch: `hold()` keeps the later `until` in `held` and emits
//   `queue:held` when it set or extended it, and `release()` clears it and emits `queue:released`. The items are not
//   changed: no attempt is counted, and nothing is failed or parked.
// - `move()` places a queued item next to another queued one and marks it `moved`: add, a priority change and a retry
//   leave a moved item where it is, and its dispatch clears the mark. It emits `queue:moved`.
// - `skippedLeased()`, `watched()` and `unwatched()` only emit their events: none of them changes `queue.json`.
// - Every event the store emits is handed to `onEvent` once it is appended, in order: the watcher's terminal lines. A
//   hook that throws is ignored, so the terminal never breaks the queue.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { replaceFile } from '../engine/durable';
import type { NewQueueEvent, QueueEvent, ResumedFrom } from '../events/types';
import { PORT_ERROR_CODES, type PortErrorCode } from '../ports/errors';
import { type PullRequest, type Ticket, TicketPriority } from '../ports/types';
import { openQueueStream } from './queue-events';

export const QUEUE_DIR = 'queue';
export const QUEUE_FILE = 'queue.json';

/** Where `workflow`'s queue lives under `.sail-runs/`. */
export function queueDir(runsDir: string, workflow: string): string {
  return join(runsDir, QUEUE_DIR, workflow);
}

export const QueueSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ticket'), ticketKey: z.string().min(1) }),
  /** A pull request at one head sha: `branch` is its head, so dispatch checks the lease before asking the host. */
  z.strictObject({
    kind: z.literal('pr'),
    number: z.number().int().min(1),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    branch: z.string().min(1),
  }),
]);
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
  /** Added with `--force`: first dispatched without the re-check of designation and state, and started with `--force`. */
  forced: z.literal(true).optional(),
  /** The ticket's priority, as the last poll saw it. A pull request has none. */
  priority: TicketPriority.optional(),
  /** Placed by hand: it keeps its place, whatever its priority, until it is dispatched or dropped. */
  moved: z.literal(true).optional(),
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
  /** Set while a usage limit or an unavailable port holds the workflow's dispatch: nothing starts or resumes until `until`. */
  held: z
    .strictObject({
      until: z.string(),
      runId: z.string(),
      reason: z.string(),
      at: z.string(),
    })
    .optional(),
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
  /** How long a usage limit holds the dispatch when the provider gave no reset time. */
  usageLimitBackoffMs: number;
  /** How long a run suspended on an unavailable port holds the dispatch, by consecutive suspension; one past the end parks it. */
  portUnavailableBackoffMs: readonly number[];
}

/** The prototype's numbers (DECISIONS D6). */
export const DEFAULT_QUEUE_POLICY: QueuePolicy = {
  maxAttempts: 2,
  retryDelaysMs: [5 * 60_000, 20 * 60_000],
  pollBackoffMs: [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000],
  doneKept: 100,
  usageLimitBackoffMs: 15 * 60_000,
  portUnavailableBackoffMs: [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000],
};

/** The key a queue item is known by: `ticket:<ticket key>`, or `pr:<number>@<the head sha's first 7>`. */
export function dedupKey(source: QueueSource): string {
  return source.kind === 'ticket' ? `ticket:${source.ticketKey}` : `pr:${source.number}@${source.headSha.slice(0, 7)}`;
}

const PRIORITY_ORDER: Record<TicketPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/** Where an item's priority puts it in the queue order: `none` for a pull request or a ticket without one. */
const priorityOrder = (item: QueueItem): number => PRIORITY_ORDER[item.priority ?? 'none'];

/** Whether `a` is dispatched after `b` by (priority, addedAt). Equal keys keep the order they are in. */
const dispatchedAfter = (a: QueueItem, b: QueueItem): boolean =>
  priorityOrder(a) !== priorityOrder(b)
    ? priorityOrder(a) > priorityOrder(b)
    : Date.parse(a.addedAt) > Date.parse(b.addedAt);

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
  /** Queues each ticket whose key isn't taken, and gives how many it queued. A forced add marks each item forced. */
  add(tickets: readonly Ticket[], options?: { forced?: boolean }): number;
  /**
   * Queues each pull request at its head sha whose key isn't taken, and gives how many it queued. A `pr:` key whose item
   * is done stays taken: the same sha is never queued twice.
   */
  addPullRequests(pullRequests: readonly PullRequest[]): number;
  /** The items a dispatch may start: queued ones, and failed ones past their `retryAt`, in the order `items` holds. */
  due(): QueueItem[];
  /** Records a dispatch of the item, which counts an attempt. */
  dispatched(key: string, runId: string): void;
  /** Records the pid of the dispatched item's process, and emits `queue:dispatched`. An item not dispatched throws. */
  spawned(key: string, pid: number): void;
  /** Records the pid the dispatched item's run is alive as, and emits `run:adopted`. An item not dispatched throws. */
  adopted(key: string, pid: number): void;
  /** Records the pid of the resume started for the item's run, and emits `run:resumed`. Not dispatched: throws. */
  resumed(key: string, pid: number, from: ResumedFrom): void;
  /** Parks the item whatever its attempts, and emits `queue:parked` with the reason. */
  parked(key: string, reason: string): void;
  /**
   * Puts a parked or failed item back as queued with no attempts, and emits `queue:requeued`. Any other state throws,
   * naming it.
   */
  requeue(key: string, reason: string): void;
  /**
   * Places the queued item `key` directly before or after another queued item, marks it moved so a later add or
   * priority change leaves it there until it is dispatched or dropped, and emits `queue:moved`. A move that leaves it
   * where it is changes nothing and still emits. An item or target that is missing or not queued throws, naming why.
   */
  move(key: string, to: { before: string } | { after: string }, reason: string): void;
  /** Takes the item out of the queue, and emits `queue:dropped` with the reason. An unknown key throws. */
  drop(key: string, reason: string): void;
  /**
   * Holds the workflow's dispatch until `until` because run `runId` hit the usage limit, and emits `queue:held`. A hold
   * already set to a later time stays as it is, and emits nothing.
   */
  hold(until: string, runId: string, reason: string): void;
  /** Clears the hold and emits `queue:released`. A queue not held changes nothing. */
  release(): void;
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
  polled(poll: { kind: 'ticket' | 'pr'; found: number; added: number; durationMs: number }): void;
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

/**
 * `workflow`'s queue as its `queue.json` holds it now, undefined when it has none, or why it can't be read. It only
 * reads: `sail queue` shows a queue with it, and changes one through the watcher.
 */
export function readQueue(runsDir: string, workflow: string): QueueFile | undefined | { refused: string } {
  const path = join(queueDir(runsDir, workflow), QUEUE_FILE);
  return existsSync(path) ? readQueueFile(path) : undefined;
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
  const { onEvent } = options;
  /** Appends the events, then hands each to `onEvent`. */
  const emitAll = (events: readonly NewQueueEvent[]): void => {
    for (const event of opened.emitAll(events)) {
      try {
        onEvent?.(event);
      } catch {
        // The terminal's trouble: the event is in the stream all the same.
      }
    }
  };
  const stream = { emit: (event: NewQueueEvent) => emitAll([event]), emitAll };

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
  /** Records `pid` on the dispatched item `key`, and gives the item. One not dispatched throws. */
  const dispatchedWith = (key: string, pid: number): QueueItem =>
    change((next) => {
      const item = find(next, key);
      if (item.state !== 'dispatched') throw new Error(`${workflow}'s item ${key} is ${item.state}, not dispatched`);
      item.pid = pid;
      return { ...item };
    });
  const emitAdded = (added: readonly QueueItem[]) =>
    stream.emitAll(
      added.map((item) => ({
        type: 'queue:item_added' as const,
        workflow,
        dedupKey: item.dedupKey,
        source: item.source,
        title: item.title,
      })),
    );
  /**
   * Puts `item` in `next.items` before the first unmoved pending item that is dispatched after it, or at the end when
   * none is. Moved items are never compared with, so they keep their places.
   */
  const place = (next: QueueFile, item: QueueItem): void => {
    const unmoved = (each: QueueItem) => (each.state === 'queued' || each.state === 'failed') && each.moved !== true;
    const at = next.items.indexOf(item);
    if (at >= 0) {
      // An item whose neighbours among the unmoved ones already bracket it stays, so equal keys keep their order.
      const after = next.items.slice(at + 1).find(unmoved);
      const behind = next.items.slice(0, at).findLast(unmoved);
      if (
        (behind === undefined || !dispatchedAfter(behind, item)) &&
        (after === undefined || !dispatchedAfter(item, after))
      )
        return;
      next.items.splice(at, 1);
    }
    const before = next.items.findIndex((each) => unmoved(each) && dispatchedAfter(each, item));
    if (before < 0) next.items.push(item);
    else next.items.splice(before, 0, item);
  };
  const isDue = (item: QueueItem, at: number) =>
    item.state === 'queued' || (item.state === 'failed' && Date.parse(item.retryAt ?? '') <= at);

  return {
    snapshot: () => structuredClone(queue),
    add(tickets, options = {}) {
      const added = change((next) => {
        const queued: QueueItem[] = [];
        for (const ticket of tickets) {
          const key = dedupKey({ kind: 'ticket', ticketKey: ticket.ticketKey });
          const taken = next.items.find((item) => item.dedupKey === key);
          if (taken !== undefined && taken.state !== 'done') {
            if ((taken.state === 'queued' || taken.state === 'failed') && taken.priority !== ticket.priority) {
              if (ticket.priority === undefined) delete taken.priority;
              else taken.priority = ticket.priority;
              if (taken.moved !== true) place(next, taken);
            }
            continue;
          }
          if (taken !== undefined) next.items.splice(next.items.indexOf(taken), 1);
          const item: QueueItem = {
            dedupKey: key,
            source: { kind: 'ticket', ticketKey: ticket.ticketKey },
            title: ticket.title,
            url: ticket.url,
            state: 'queued',
            attempts: 0,
            addedAt: now().toISOString(),
            ...(options.forced === true ? { forced: true as const } : {}),
            ...(ticket.priority === undefined ? {} : { priority: ticket.priority }),
          };
          place(next, item);
          queued.push(item);
        }
        return queued;
      });
      emitAdded(added);
      return added.length;
    },
    addPullRequests(pullRequests) {
      const added = change((next) => {
        const queued: QueueItem[] = [];
        for (const pr of pullRequests) {
          const source = { kind: 'pr' as const, number: pr.number, headSha: pr.headSha, branch: pr.head };
          const key = dedupKey(source);
          const taken = next.items.find((item) => item.dedupKey === key);
          // A key is the sha's first 7, so another sha can share it: a done item at another sha gives way to the new
          // one, and one not done holds the key until it is (a queued one is dropped at dispatch as moved).
          const same = taken?.source.kind === 'pr' && taken.source.headSha === pr.headSha;
          if (taken !== undefined && (same || taken.state !== 'done')) continue;
          if (taken !== undefined) next.items.splice(next.items.indexOf(taken), 1);
          const item: QueueItem = {
            dedupKey: key,
            source,
            title: pr.title,
            url: pr.url,
            state: 'queued',
            attempts: 0,
            addedAt: now().toISOString(),
          };
          place(next, item);
          queued.push(item);
        }
        return queued;
      });
      emitAdded(added);
      return added.length;
    },
    due() {
      const at = now().getTime();
      return structuredClone(queue.items.filter((item) => isDue(item, at)));
    },
    dispatched(key, runId) {
      change((next) => {
        const item = find(next, key);
        item.state = 'dispatched';
        item.attempts += 1;
        item.runId = runId;
        delete item.moved;
        delete item.retryAt;
        delete item.pid;
      });
    },
    spawned(key, pid) {
      const item = change((next) => {
        const spawning = find(next, key);
        if (spawning.state !== 'dispatched')
          throw new Error(`${workflow}'s item ${key} is ${spawning.state}, not dispatched`);
        spawning.pid = pid;
        return { ...spawning };
      });
      stream.emit({
        type: 'queue:dispatched',
        workflow,
        dedupKey: key,
        run: item.runId ?? '',
        attempt: item.attempts,
        pid,
      });
    },
    adopted(key, pid) {
      const item = dispatchedWith(key, pid);
      stream.emit({ type: 'run:adopted', workflow, dedupKey: key, run: item.runId ?? '', pid });
    },
    resumed(key, pid, from) {
      const item = dispatchedWith(key, pid);
      stream.emit({ type: 'run:resumed', workflow, dedupKey: key, run: item.runId ?? '', pid, from });
    },
    parked(key, reason) {
      const item = change((next) => {
        const parking = find(next, key);
        parking.state = 'parked';
        parking.reason = reason;
        parking.finishedAt = now().toISOString();
        delete parking.retryAt;
        return { ...parking };
      });
      stream.emit({ type: 'queue:parked', workflow, dedupKey: key, attempts: item.attempts, reason });
    },
    requeue(key, reason) {
      change((next) => {
        const item = find(next, key);
        if (item.state !== 'parked' && item.state !== 'failed') {
          throw new Error(`${workflow}'s item ${key} is ${item.state}: only a parked or failed item is requeued`);
        }
        item.state = 'queued';
        item.attempts = 0;
        for (const field of ['reason', 'retryAt', 'finishedAt', 'runId', 'pid'] as const) delete item[field];
        place(next, item);
      });
      stream.emit({ type: 'queue:requeued', workflow, dedupKey: key, reason });
    },
    move(key, to, reason) {
      const targetKey = 'before' in to ? to.before : to.after;
      change((next) => {
        const item = find(next, key);
        const target = find(next, targetKey);
        if (item === target) throw new Error(`${workflow}'s item ${key} can't be moved next to itself`);
        for (const each of [item, target]) {
          if (each.state !== 'queued') {
            throw new Error(`${workflow}'s item ${each.dedupKey} is ${each.state}: only a queued item is moved`);
          }
        }
        next.items.splice(next.items.indexOf(item), 1);
        next.items.splice(next.items.indexOf(target) + ('before' in to ? 0 : 1), 0, item);
        item.moved = true;
      });
      stream.emit({ type: 'queue:moved', workflow, dedupKey: key, ...to, reason });
    },
    drop(key, reason) {
      change((next) => {
        next.items.splice(next.items.indexOf(find(next, key)), 1);
      });
      stream.emit({ type: 'queue:dropped', workflow, dedupKey: key, reason });
    },
    hold(until, runId, reason) {
      const current = queue.held;
      if (current !== undefined && Date.parse(current.until) >= Date.parse(until)) return;
      change((next) => {
        next.held = { until, runId, reason, at: now().toISOString() };
      });
      stream.emit({ type: 'queue:held', workflow, until, run: runId, reason });
    },
    release() {
      if (queue.held === undefined) return;
      change((next) => {
        delete next.held;
      });
      stream.emit({ type: 'queue:released', workflow });
    },
    skippedLeased(key, branch, heldBy) {
      stream.emit({ type: 'queue:skipped_leased', workflow, dedupKey: key, branch, heldBy });
    },
    watched({ pid, everyMs, maxConcurrentRuns }) {
      stream.emit({ type: 'watch:added', workflow, pid, label: queue.polling.label, everyMs, maxConcurrentRuns });
    },
    unwatched(pid) {
      stream.emit({ type: 'watch:removed', workflow, pid });
    },
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
          place(next, failing);
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

/** The dispatched item of any of the clone's queues that names run `runId`, or undefined. A queue that can't be read is skipped. */
export function dispatchedItem(runsDir: string, runId: string): QueueItem | undefined {
  const root = join(runsDir, QUEUE_DIR);
  if (!existsSync(root)) return undefined;
  for (const workflow of readdirSync(root)) {
    const queue = readQueue(runsDir, workflow);
    if (queue === undefined || 'refused' in queue) continue;
    const found = queue.items.find((item) => item.state === 'dispatched' && item.runId === runId);
    if (found !== undefined) return found;
  }
  return undefined;
}
