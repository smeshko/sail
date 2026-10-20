// `sail queue ls|add|requeue|drop|poll <workflow> [<item>|<ticket>] [--force]`: a watched workflow's queue from the CLI
// (DECISIONS D8, D9).
//
// - `ls` reads its queue file, with or without a watcher: the workflow's polling, then each item in queue order with its
//   state, its dedup key, its title and what applies of its run, attempts, retry time, `forced` and reason.
// - `add`, `requeue`, `drop` and `poll` change the queue only through the live watcher of this repository, and only for
//   a workflow in its set: the watcher alone writes its queue file. Each checks what it can first, so the refusal shows
//   in this terminal: `add` the ticket as a start checks it, designated and unstarted unless `--force`, and not already
//   queued; `requeue` an item that is parked or failed and whose last run has ended; `drop` an item that isn't
//   dispatched. Then it drops the command, waits up to 15 s for the watcher to take it, and prints the item as
//   its queue file holds it then. A command not taken in time waits in the inbox, and the command exits 0 saying so, as
//   `sail watch` does. One the watcher took but didn't apply exits 3: its terminal says why.
//
// An item is named by its dedup key (`ticket:FAKE-1`, as the dashboard's commands print it) or its ticket key. Every
// refusal is exit code 3.
import { join } from 'node:path';
import { isAlive as processIsAlive } from '../../adapters/leases';
import { readStatus, runsDir as runsDirOf } from '../../engine/run-dir';
import { resolveSource } from '../../engine/source';
import { clean } from '../../events/consumers/screen';
import { dropCommand, type Command as QueueCommand } from '../../watch/inbox';
import { dedupKey, type QueueFile, type QueueItem, readQueue } from '../../watch/queue-store';
import { holderRefusal } from '../../watch/watcher';
import { EXIT_OK, type ExitCode } from '../exit-codes';
import type { Command, Io } from '../index';
import { at, findProject, refuseAs } from './run-workflow';
import { findWatcher, liveSet, taken, type WatchDeps } from './watch';

const COMMAND = 'sail queue';
const OPS = ['ls', 'add', 'requeue', 'drop', 'poll'] as const;
type Op = (typeof OPS)[number];

/** A workflow's name, as a folder under `.sail/workflows/` takes it. */
const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]*$/;

const USAGE: Record<Op, string> = {
  ls: 'sail queue ls <workflow>',
  add: 'sail queue add <workflow> <ticket> [--force]',
  requeue: 'sail queue requeue <workflow> <item>',
  drop: 'sail queue drop <workflow> <item>',
  poll: 'sail queue poll <workflow>',
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** `workflow`'s queue as its queue file holds it, undefined when it has none. One that can't be read throws. */
function queueOf(runs: string, workflow: string): QueueFile | undefined {
  const queue = readQueue(runs, workflow);
  if (queue !== undefined && 'refused' in queue) throw new Error(queue.refused);
  return queue;
}

/** One item: `<state> <dedup key> <title>`, then what applies of its run, attempts, retry time, `forced` and reason. */
function itemLine(item: QueueItem): string {
  const details = [
    item.runId === undefined ? undefined : `run ${item.runId}`,
    item.attempts === 0 ? undefined : plural(item.attempts, 'attempt'),
    item.retryAt === undefined ? undefined : `retry at ${item.retryAt}`,
    item.forced === true ? 'forced' : undefined,
    item.reason === undefined ? undefined : clean(item.reason),
  ].filter((detail) => detail !== undefined);
  const line = `${item.state} ${item.dedupKey} ${clean(item.title)}`;
  return details.length === 0 ? line : `${line} · ${details.join(', ')}`;
}

/** The item `ref` names, by its dedup key or its ticket key. */
const itemOf = (queue: QueueFile | undefined, ref: string): QueueItem | undefined =>
  queue?.items.find((item) => item.dedupKey === ref || item.source.ticketKey === ref);

const noQueue = (workflow: string) => `no queue for '${workflow}' in .sail-runs/queue: it has never been watched`;

/** `sail queue ls`: the queue's polling, then each item, in queue order. */
function list(io: Io, runs: string, workflow: string): ExitCode {
  const queue = queueOf(runs, workflow);
  if (queue === undefined) return refuseAs(io, COMMAND)(noQueue(workflow));
  const { label, lastPolledAt, paused } = queue.polling;
  const pause = paused === undefined ? '' : `, paused: ${clean(paused.message)}`;
  io.stdout(`${workflow}: label ${label}, last polled ${lastPolledAt ?? 'never'}${pause}\n`);
  for (const item of queue.items) io.stdout(`${itemLine(item)}\n`);
  return EXIT_OK;
}

/** How the run `runId` stands, `<status>[ <stop reason>]`, when it has not ended; undefined when it has, or has none. */
function unended(runs: string, runId: string | undefined): string | undefined {
  if (runId === undefined) return undefined;
  try {
    const { status, stopReason } = readStatus(join(runs, runId));
    if (status !== 'running' && status !== 'suspended') return undefined;
    return stopReason === undefined ? status : `${status} ${stopReason}`;
  } catch {
    return undefined;
  }
}

/** `sail queue`, on `deps`. */
export function queueCommand(deps: WatchDeps = {}): Command {
  return async (args, io) => {
    const refuse = refuseAs(io, COMMAND);
    const [given, workflow, ref] = args.positionals;
    if (given === undefined) return refuse(`name an operation: ${OPS.join(', ')}`);
    const op = OPS.find((each) => each === given);
    if (op === undefined) return refuse(`unknown operation '${given}': the operations are ${OPS.join(', ')}`);
    if (workflow === undefined) return refuse(`name the workflow: ${USAGE[op]}`);
    if (!WORKFLOW_NAME.test(workflow)) return refuse(`'${workflow}' is not a workflow's name: ${USAGE[op]}`);
    const takesRef = op === 'add' || op === 'requeue' || op === 'drop';
    if (takesRef && ref === undefined) return refuse(`name the ${op === 'add' ? 'ticket' : 'item'}: ${USAGE[op]}`);
    if (!takesRef && ref !== undefined) return refuse(`unknown argument '${ref}': ${USAGE[op]}`);
    const force = args.values.force === true;
    if (force && op !== 'add') return refuse(`--force belongs to sail queue add: ${USAGE[op]}`);

    const project = await findProject(io, COMMAND, { ports: op === 'add' ? ['ticketSource'] : [] });
    if (typeof project === 'number') return project;
    const runs = runsDirOf(project.sailDir);
    if (op === 'ls') return list(io, runs, workflow);

    const { entry, holder } = await findWatcher(io, project, deps.isAlive ?? processIsAlive);
    if (holder?.kind === 'name') return refuse(holderRefusal(holder, entry.name));
    if (holder?.kind !== 'here') {
      return refuse(`no watcher is running for '${entry.name}' here: sail watch ${workflow} first`);
    }
    const { pid } = holder.watcher;
    const watcher = `the watcher of '${entry.name}' (pid ${pid})`;
    const watched = liveSet(project.sailDir, pid).find((each) => each.workflow === workflow);
    if (watched === undefined) return refuse(`${watcher} does not watch '${workflow}'`);

    const queue = queueOf(runs, workflow);
    let command: QueueCommand;
    let key: string | undefined;
    if (op === 'poll') {
      command = { op: 'poll', workflow };
    } else if (op === 'add') {
      const { ticketSource } = project.adapters.ports;
      const resolved = await resolveSource({ ref: ref ?? '', ticketSource, label: watched.label, force });
      if ('refused' in resolved) return refuse(resolved.refused);
      key = dedupKey({ kind: 'ticket', ticketKey: resolved.ticketKey });
      const queued = itemOf(queue, key);
      if (queued !== undefined && queued.state !== 'done') {
        return refuse(`${key} is in ${workflow}'s queue already: ${itemLine(queued)}`);
      }
      command = { op: 'add', workflow, ticketKey: resolved.ticketKey, ...(force ? { force: true as const } : {}) };
    } else {
      const item = itemOf(queue, ref ?? '');
      if (item === undefined) return refuse(`${workflow}'s queue has no item ${ref}`);
      key = item.dedupKey;
      if (op === 'drop' && item.state === 'dispatched') {
        return refuse(`${key} can't be dropped: its run ${item.runId} has not ended: sail stop ${item.runId} first`);
      }
      if (op === 'requeue') {
        if (item.state !== 'parked' && item.state !== 'failed') {
          return refuse(`${key} is ${item.state}: only a parked or failed item is requeued`);
        }
        const run = unended(runs, item.runId);
        if (run !== undefined) {
          return refuse(
            `${key} can't be requeued: its run ${item.runId} is ${run}, and holds its branch: sail resume ${item.runId} or sail stop ${item.runId} first`,
          );
        }
      }
      command = { op, workflow, dedupKey: key };
    }

    const file = dropCommand(runs, command);
    if (!(await taken(file, deps))) {
      io.stdout(`${COMMAND}: ${watcher} has not taken the command yet: it waits in ${at(io, file)}\n`);
      return EXIT_OK;
    }
    if (op === 'poll') {
      io.stdout(`${COMMAND}: ${watcher} polls ${workflow} now\n`);
      return EXIT_OK;
    }
    const after = itemOf(queueOf(runs, workflow), key ?? '');
    const applied =
      op === 'drop'
        ? after === undefined
        : op === 'requeue'
          ? after !== undefined && after.state !== 'parked' && after.state !== 'failed'
          : after !== undefined && after.state !== 'done';
    if (!applied) return refuse(`the watcher did not ${op} ${key}: its terminal says why`);
    io.stdout(`${COMMAND}: ${after === undefined ? `${key} dropped` : itemLine(after)}\n`);
    return EXIT_OK;
  };
}

export const queue = queueCommand();
