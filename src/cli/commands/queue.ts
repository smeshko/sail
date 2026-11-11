// `sail queue ls|add|requeue|drop|poll|move <workflow> [<item>|<ticket>] [--force] [--before|--after <item>]`: a
// watched workflow's queue from the CLI (DECISIONS D8, D9).
//
// - `ls` reads its queue file, with or without a watcher: the workflow's polling, then the held runs that fill a slot of
//   the workflow (read from the run directories), then each item in queue order with its
//   state, its dedup key, its title and what applies of its priority (unless none), run, attempts, retry time,
//   what it waits on, `forced`, `moved` and reason.
// - `move` puts a queued item directly before or after another queued one, exactly one of `--before` and `--after`;
//   the two flags belong to it alone. It is refused unless both items are queued and different.
// - `add`, `requeue`, `drop`, `poll` and `move` change the queue only through the live watcher of this repository, and only for
//   a workflow in its set: the watcher alone writes its queue file. Each checks what it can first, so the refusal shows
//   in this terminal: `add` the ticket as a start checks it, designated and in a pick-up state unless `--force`, and not already
//   queued, for a workflow that polls tickets only; `requeue` an item that is parked or failed and whose last run has ended; `drop` an item that isn't
//   dispatched. Then it drops the command, waits up to 15 s for the watcher to take it, and prints the item as
//   its queue file holds it then. A command not taken in time waits in the inbox, and the command exits 0 saying so, as
//   `sail watch` does. One the watcher took but didn't apply exits 3: its terminal says why. What it applied is read
//   from the events it emitted for the item since, so an add or a requeue its dispatch then dropped, as a ticket left
//   In Progress is, exits 3 saying both, with the reason.
//
// The checks, the command to drop and the reading of what the watcher did are `src/watch/queue-commands.ts`'s, which
// the dashboard's queue view shares.
//
// An item is named by its dedup key (`ticket:FAKE-1`, as `sail queue ls` prints it) or its ticket key. Every
// refusal is exit code 3.
import { isAlive as processIsAlive } from '../../adapters/leases';
import { runsDir as runsDirOf } from '../../engine/run-dir';
import { heldRuns } from '../../engine/runs';
import { clean } from '../../events/consumers/screen';
import { dropCommand, NOT_TAKEN } from '../../watch/inbox';
import { commandFor, itemLine, outcomeOf, queueOf, streamMark } from '../../watch/queue-commands';
import { liveSet } from '../../watch/registry';
import { holderRefusal } from '../../watch/watcher';
import { EXIT_OK, type ExitCode } from '../exit-codes';
import type { Command, Io } from '../index';
import { at, findProject, refuseAs } from './run-workflow';
import { findWatcher, taken, type WatchDeps } from './watch';

const COMMAND = 'sail queue';
const OPS = ['ls', 'add', 'requeue', 'drop', 'poll', 'move'] as const;
type Op = (typeof OPS)[number];

/** A workflow's name, as a folder under `.sail/workflows/` takes it. */
const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]*$/;

const USAGE: Record<Op, string> = {
  ls: 'sail queue ls <workflow>',
  add: 'sail queue add <workflow> <ticket> [--force]',
  requeue: 'sail queue requeue <workflow> <item>',
  drop: 'sail queue drop <workflow> <item>',
  poll: 'sail queue poll <workflow>',
  move: 'sail queue move <workflow> <item> --before <item> | --after <item>',
};

const noQueue = (workflow: string) => `no queue for '${workflow}' in .sail-runs/queue: it has never been watched`;

/** `sail queue ls`: the queue's polling, then each item, in queue order. */
function list(io: Io, runs: string, workflow: string): ExitCode {
  const queue = queueOf(runs, workflow);
  if (queue === undefined) return refuseAs(io, COMMAND)(noQueue(workflow));
  const { label, lastPolledAt, paused } = queue.polling;
  const pause = paused === undefined ? '' : `, paused: ${clean(paused.message)}`;
  const held =
    queue.held === undefined
      ? ''
      : `, dispatch held${queue.held.until === undefined ? `: ${queue.held.reason}` : ` until ${queue.held.until}`}`;
  const heldRunIds = heldRuns(runs, workflow);
  const slots =
    heldRunIds.length === 0
      ? ''
      : `, ${heldRunIds.length} ${heldRunIds.length === 1 ? 'slot filled by held run' : 'slots filled by held runs'} ${heldRunIds.join(', ')}`;
  io.stdout(`${workflow}: label ${label}, last polled ${lastPolledAt ?? 'never'}${pause}${held}${slots}\n`);
  for (const item of queue.items) io.stdout(`${itemLine(item)}\n`);
  return EXIT_OK;
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
    const takesRef = op === 'add' || op === 'requeue' || op === 'drop' || op === 'move';
    if (takesRef && ref === undefined) return refuse(`name the ${op === 'add' ? 'ticket' : 'item'}: ${USAGE[op]}`);
    if (!takesRef && ref !== undefined) return refuse(`unknown argument '${ref}': ${USAGE[op]}`);
    const force = args.values.force === true;
    if (force && op !== 'add') return refuse(`--force belongs to sail queue add: ${USAGE[op]}`);
    const { before, after: behind } = args.values;
    const sides = [before, behind].filter((side) => side !== undefined);
    if (op === 'move' ? sides.length !== 1 : sides.length > 0) {
      return refuse(
        op === 'move'
          ? `name exactly one of --before and --after: ${USAGE.move}`
          : `--before and --after belong to sail queue move: ${USAGE[op]}`,
      );
    }
    const side = typeof before === 'string' ? before : behind;
    if (op === 'move' && (typeof side !== 'string' || side === '')) {
      return refuse(`name the item to move it next to: ${USAGE.move}`);
    }

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

    const { ticketSource } = project.adapters.ports;
    const checked = await commandFor(op, {
      runs,
      sailDir: project.sailDir,
      config: project.config,
      workflow,
      label: watched.label,
      ref: ref ?? '',
      force,
      ...(typeof before === 'string' ? { before } : {}),
      ...(typeof behind === 'string' ? { after: behind } : {}),
      ...(op === 'add' ? { ticketSource } : {}),
    });
    if ('refused' in checked) return refuse(checked.refused);
    const { command, key } = checked;

    const mark = streamMark(runs, workflow);
    const file = dropCommand(runs, command);
    if (!(await taken(file, deps))) {
      io.stdout(`${COMMAND}: ${watcher} ${NOT_TAKEN}: it waits in ${at(io, file)}\n`);
      return EXIT_OK;
    }
    if (op === 'poll') {
      io.stdout(`${COMMAND}: ${watcher} polls ${workflow} now\n`);
      return EXIT_OK;
    }
    const outcome = outcomeOf(runs, workflow, op, key ?? '', mark);
    if ('refused' in outcome) return refuse(outcome.refused);
    const { applied } = outcome;
    io.stdout(`${COMMAND}: ${applied === undefined ? `${key} dropped` : itemLine(applied)}\n`);
    return EXIT_OK;
  };
}

export const queue = queueCommand();
