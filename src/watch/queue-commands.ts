// What `sail queue` and the dashboard's queue view share for a change to a watched workflow's queue: the checks made
// before a command is dropped in the watcher's inbox, the command itself, and the reading of what the watcher did with
// it. Neither caller writes a queue; the watcher alone does (ADR-0019).
//
// - `commandFor()` checks an `add`, `requeue`, `drop`, `move` or `poll` as the CLI always has, and gives the command to
//   drop with the dedup key of the item it concerns, or the refusal, worded for a person.
// - `streamMark()` is the last `seq` of the workflow's queue event stream, taken just before the command is dropped.
// - `outcomeOf()` reads, once the watcher has taken the command, the events it emitted for the item after that mark: an
//   item the watcher applied the change to is read back from the queue file, and one it didn't, or applied and then
//   dropped, is a refusal with the reason.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '../engine/config';
import { readStatus } from '../engine/run-dir';
import { resolveSource } from '../engine/source';
import { EVENTS_FILE } from '../events/consumers/ndjson';
import { clean } from '../events/consumers/screen';
import type { TicketSource } from '../ports/ticket-source';
import type { Command } from './inbox';
import { readWatch } from './poll';
import { dedupKey, type QueueFile, type QueueItem, queueDir, readQueue } from './queue-store';
import { addsNoTicket } from './watcher';

export type QueueOp = 'poll' | 'add' | 'requeue' | 'drop' | 'move';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** `workflow`'s queue as its queue file holds it, undefined when it has none. One that can't be read throws. */
export function queueOf(runs: string, workflow: string): QueueFile | undefined {
  const queue = readQueue(runs, workflow);
  if (queue !== undefined && 'refused' in queue) throw new Error(queue.refused);
  return queue;
}

/**
 * One item: `<state> <dedup key> <title>`, then what applies of its priority (unless none), run, attempts, retry time,
 * hold, what it waits on, `forced`, `moved` and reason.
 */
export function itemLine(item: QueueItem): string {
  const details = [
    item.priority === undefined || item.priority === 'none' ? undefined : `priority ${item.priority}`,
    item.runId === undefined ? undefined : `run ${item.runId}`,
    item.attempts === 0 ? undefined : plural(item.attempts, 'attempt'),
    item.retryAt === undefined ? undefined : `retry at ${item.retryAt}`,
    item.held === undefined ? undefined : `held until ${item.held.until}: ${clean(item.held.reason)}`,
    item.waitingOn === undefined ? undefined : `waiting on ${item.waitingOn.map(clean).join(', ')}`,
    item.forced === true ? 'forced' : undefined,
    item.moved === true ? 'moved' : undefined,
    item.reason === undefined ? undefined : clean(item.reason),
  ].filter((detail) => detail !== undefined);
  const line = `${item.state} ${item.dedupKey} ${clean(item.title)}`;
  return details.length === 0 ? line : `${line} · ${details.join(', ')}`;
}

/** The item `ref` names, by its dedup key or its ticket key. */
export const itemOf = (queue: QueueFile | undefined, ref: string): QueueItem | undefined =>
  queue?.items.find(
    (item) => item.dedupKey === ref || (item.source.kind === 'ticket' && item.source.ticketKey === ref),
  );

/** How the run `runId` stands, `<status>[ <stop reason>]`, when it has not ended; undefined when it has, or has none. */
export function unended(runs: string, runId: string | undefined): string | undefined {
  if (runId === undefined) return undefined;
  try {
    const { status, stopReason } = readStatus(join(runs, runId));
    if (status !== 'running' && status !== 'suspended') return undefined;
    return stopReason === undefined ? status : `${status} ${stopReason}`;
  } catch {
    return undefined;
  }
}

/** The lines of `workflow`'s queue event stream, each parsed, or undefined for a line that isn't JSON. */
export function streamLines(runs: string, workflow: string): (Record<string, unknown> | undefined)[] {
  const file = join(queueDir(runs, workflow), EVENTS_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    });
}

const seqOf = (event: Record<string, unknown> | undefined) => (typeof event?.seq === 'number' ? event.seq : 0);

/** The highest `seq` in `workflow`'s queue event stream, 0 for an empty one. */
export function streamMark(runs: string, workflow: string): number {
  return Math.max(0, ...streamLines(runs, workflow).map(seqOf));
}

/** The event each change emits when the watcher applies it. */
export const APPLIED_AS = {
  add: 'queue:item_added',
  requeue: 'queue:requeued',
  drop: 'queue:dropped',
  move: 'queue:moved',
} as const;
export const DONE_AS = { add: 'added', requeue: 'requeued', drop: 'dropped', move: 'moved' } as const;

export interface CommandOptions {
  /** `.sail-runs/` of the clone. */
  runs: string;
  sailDir: string;
  config: Pick<ProjectConfig, 'label'>;
  workflow: string;
  /** The label the watcher polls the workflow on. */
  label: string;
  /** The ticket an `add` names, or the item the other operations name. */
  ref?: string;
  /** For `add`: skip the designation and state checks. */
  force?: boolean;
  /** For `move`: the item to put it next to, and on which side. */
  before?: string;
  after?: string;
  /** For `add`: the clone's TicketSource. */
  ticketSource?: TicketSource;
}

/**
 * The command to drop for `op`, once the checks a person would want to see refused have passed: `add` the ticket as a
 * start checks it, designated and in a pick-up state unless forced, and not already queued, for a workflow that polls
 * tickets only; `requeue` an item that is parked or failed and whose last run has ended; `drop` an item that isn't
 * dispatched; `move` a queued item next to another queued one. `key` is the dedup key of the item it concerns.
 */
export async function commandFor(
  op: QueueOp,
  options: CommandOptions,
): Promise<{ command: Command; key?: string } | { refused: string }> {
  const { runs, sailDir, config, workflow, label, ref = '', force = false } = options;
  if (op === 'poll') return { command: { op: 'poll', workflow } };
  const queue = queueOf(runs, workflow);
  if (op === 'add') {
    const declared = await readWatch({ sailDir, config, name: workflow });
    if (!('refused' in declared) && declared.kind !== 'ticket') return { refused: addsNoTicket(workflow) };
    if (options.ticketSource === undefined) throw new Error('an add needs the ticket source');
    const resolved = await resolveSource({ ref, ticketSource: options.ticketSource, label, force });
    if ('refused' in resolved) return { refused: resolved.refused };
    const key = dedupKey({ kind: 'ticket', ticketKey: resolved.ticketKey });
    const queued = itemOf(queue, key);
    if (queued !== undefined && queued.state !== 'done') {
      return { refused: `${key} is in ${workflow}'s queue already: ${itemLine(queued)}` };
    }
    return {
      command: { op, workflow, ticketKey: resolved.ticketKey, ...(force ? { force: true as const } : {}) },
      key,
    };
  }
  const item = itemOf(queue, ref);
  if (item === undefined) return { refused: `${workflow}'s queue has no item ${ref}` };
  const key = item.dedupKey;
  if (op === 'drop' && item.state === 'dispatched') {
    return { refused: `${key} can't be dropped: its run ${item.runId} has not ended: sail stop ${item.runId} first` };
  }
  if (op === 'requeue') {
    if (item.state !== 'parked' && item.state !== 'failed') {
      return { refused: `${key} is ${item.state}: only a parked or failed item is requeued` };
    }
    const run = unended(runs, item.runId);
    if (run !== undefined) {
      return {
        refused: `${key} can't be requeued: its run ${item.runId} is ${run}, and holds its branch: sail resume ${item.runId} or sail stop ${item.runId} first`,
      };
    }
  }
  if (op === 'move') {
    const side = options.before ?? options.after ?? '';
    const target = itemOf(queue, side);
    if (target === undefined) return { refused: `${workflow}'s queue has no item ${side}` };
    if (target === item) return { refused: `${key} can't be moved next to itself` };
    for (const each of [item, target]) {
      if (each.state !== 'queued') return { refused: `${each.dedupKey} is ${each.state}: only a queued item is moved` };
    }
    return {
      command: {
        op,
        workflow,
        dedupKey: key,
        ...(options.before === undefined ? { after: target.dedupKey } : { before: target.dedupKey }),
      },
      key,
    };
  }
  return { command: { op, workflow, dedupKey: key }, key };
}

/**
 * What the watcher did with the `op` it took for `key`, read from the events it emitted for the item after `mark`, not
 * from the queue file alone: a dispatch may drop an item the watcher has just queued again, in the same tick. `applied`
 * is the item as its queue file holds it now, undefined for a drop.
 */
export function outcomeOf(
  runs: string,
  workflow: string,
  op: Exclude<QueueOp, 'poll'>,
  key: string,
  mark: number,
): { applied: QueueItem | undefined } | { refused: string } {
  const since = streamLines(runs, workflow).filter((event) => seqOf(event) > mark && event?.dedupKey === key);
  if (!since.some((event) => event?.type === APPLIED_AS[op])) {
    return { refused: `the watcher did not ${op} ${key}: its terminal says why` };
  }
  const after = itemOf(queueOf(runs, workflow), key);
  if (after === undefined && op !== 'drop') {
    const dropped = since.findLast((event) => event?.type === 'queue:dropped');
    return { refused: `the watcher ${DONE_AS[op]} ${key}, then dropped it: ${clean(String(dropped?.reason ?? ''))}` };
  }
  return { applied: after };
}
