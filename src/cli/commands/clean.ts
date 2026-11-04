// `sail clean <run>... | --failed [--requeue|--drop]`: removes each failed run's worktree, branches and run ref, and
// archives its run directory under the sail home's `failed-runs/` (the engine's `cleanRun()`). The runs are named by
// their exact ids, or are every failed run of the repository with --failed. It resolves the Workspace port, the code host
// only when a run's branch is on the remote, and the ticket source only for a ticket run, so a clean needs no
// credentials otherwise.
//
// A cleaned ticket run's ticket is moved from started back to unstarted through TicketSource `update` (the engine's
// `resetTicket()`); a ticket in any other state is left alone. A reset that fails is reported and exits 1, the clean's
// archive staying.
//
// A run that a queue item names is refused unless --requeue or --drop says what to do with the item. Then the item is
// checked first, as `sail queue requeue|drop` checks it (a live watcher of this repository, watching the item's
// workflow), so a refusal leaves the run whole. The run is cleaned and its ticket reset, and only then does the command
// reach the watcher as a command file; --drop takes the watcher's label off the ticket too. A reset that failed settles
// nothing: dispatch would only drop a requeued ticket still In Progress.
//
// Exit 3 when any run was refused, else 1 when any removal failed, else 0. Each run is cleaned in turn, whatever the
// ones before it came to.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILTINS } from '../../adapters/index';
import { isAlive as processIsAlive } from '../../adapters/leases';
import { resolveAdapters } from '../../engine/adapters';
import { cleanedMessage, cleanRun, resetTicket } from '../../engine/clean';
import { runsDir } from '../../engine/run-dir';
import { readRunHeader } from '../../engine/run-header';
import { listRuns } from '../../engine/runs';
import { formatIssue } from '../../engine/schemas';
import type { CodeHost } from '../../ports/code-host';
import { PortError } from '../../ports/errors';
import type { TicketSource } from '../../ports/ticket-source';
import { dropCommand, NOT_TAKEN, type Command as WatcherCommand } from '../../watch/inbox';
import { commandFor, itemLine, outcomeOf, streamMark } from '../../watch/queue-commands';
import { type QueueItem, queueItemsNaming } from '../../watch/queue-store';
import { liveSet } from '../../watch/registry';
import { holderRefusal } from '../../watch/watcher';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED, type ExitCode } from '../exit-codes';
import type { Command } from '../index';
import { at, findProject, refuseAs } from './run-workflow';
import { findWatcher, taken, type WatchDeps } from './watch';

const COMMAND = 'sail clean';
const USAGE = 'usage: sail clean <run>... | --failed [--requeue|--drop]';

/** The live watcher of this repository that watches a workflow, and the label it polls it on. */
interface Watching {
  pid: number;
  label: string;
}

/** The queue item a clean settles after it, and the command that settles it. */
interface Settle {
  item: QueueItem;
  workflow: string;
  watching: Watching;
  command: WatcherCommand;
  key: string;
}

export function cleanCommand(deps: WatchDeps = {}): Command {
  return async (args, io) => {
    const refuse = refuseAs(io, COMMAND);
    const failedOnly = args.values.failed === true;
    const requeue = args.values.requeue === true;
    const drop = args.values.drop === true;
    if (failedOnly === args.positionals.length > 0 || (requeue && drop)) return refuse(USAGE);
    const project = await findProject(io, COMMAND, { ports: ['workspace'] });
    if (typeof project === 'number') return project;
    const env = io.env ?? process.env;
    const runs = runsDir(project.sailDir);

    const runIds = failedOnly
      ? listRuns(project.sailDir)
          .filter((listed) => listed.status?.status === 'failed')
          .map((listed) => listed.runId)
      : [...new Set(args.positionals)];
    if (runIds.length === 0) {
      io.stderr(`${COMMAND}: no failed runs\n`);
      return EXIT_OK;
    }

    let host: Promise<CodeHost | { refused: string }> | undefined;
    const codeHost = (): Promise<CodeHost | { refused: string }> => {
      host ??= (async () => {
        const resolved = await resolveAdapters({
          sailDir: project.sailDir,
          config: project.config,
          builtins: BUILTINS,
          env,
          ports: ['codeHost'],
        });
        if ('issues' in resolved) return { refused: resolved.issues.map((issue) => formatIssue(issue)).join('; ') };
        return resolved.ports.codeHost;
      })();
      return host;
    };

    let tickets: Promise<TicketSource | { refused: string }> | undefined;
    const ticketSource = (): Promise<TicketSource | { refused: string }> => {
      tickets ??= (async () => {
        const resolved = await resolveAdapters({
          sailDir: project.sailDir,
          config: project.config,
          builtins: BUILTINS,
          env,
          ports: ['ticketSource'],
        });
        if ('issues' in resolved) return { refused: resolved.issues.map((issue) => formatIssue(issue)).join('; ') };
        return resolved.ports.ticketSource;
      })();
      return tickets;
    };
    const isTicketRun = (runId: string): boolean => {
      try {
        return readRunHeader(join(runs, runId)).source.kind === 'ticket';
      } catch {
        return false;
      }
    };
    const removeLabel = async (ticketKey: string, label: string): Promise<string | undefined> => {
      const resolved = await ticketSource();
      const failure = `the label ${label} was not removed from ${ticketKey}`;
      if ('refused' in resolved) return `${failure}: ${resolved.refused}`;
      try {
        await resolved.removeLabel(ticketKey, label);
        return undefined;
      } catch (error) {
        if (!(error instanceof PortError)) throw error;
        return `${failure}: ${error.message}`;
      }
    };

    let found: ReturnType<typeof findWatcher> | undefined;
    const watcherOf = async (workflow: string): Promise<Watching | { refused: string }> => {
      found ??= findWatcher(io, project, deps.isAlive ?? processIsAlive);
      const { entry, holder } = await found;
      if (holder?.kind === 'name') return { refused: holderRefusal(holder, entry.name) };
      if (holder?.kind !== 'here') {
        return { refused: `no watcher is running for '${entry.name}' here: sail watch ${workflow} first` };
      }
      const { pid } = holder.watcher;
      const watched = liveSet(project.sailDir, pid).find((each) => each.workflow === workflow);
      if (watched === undefined) {
        return { refused: `the watcher of '${entry.name}' (pid ${pid}) does not watch '${workflow}'` };
      }
      return { pid, label: watched.label };
    };

    const home = env.HOME ?? homedir();
    const op = requeue ? 'requeue' : 'drop';
    let code: ExitCode = EXIT_OK;
    const failed = (): void => {
      if (code !== EXIT_REFUSED) code = EXIT_FAILED;
    };
    for (const runId of runIds) {
      let source: TicketSource | undefined;
      if (isTicketRun(runId)) {
        const resolved = await ticketSource();
        if ('refused' in resolved) {
          refuse(`run ${runId}: its ticket can't be reset: ${resolved.refused}`);
          code = EXIT_REFUSED;
          continue;
        }
        source = resolved;
      }

      const naming = queueItemsNaming(runs, runId);
      const named = 'refused' in naming ? undefined : naming[0];
      let settle: Settle | undefined;
      if (named !== undefined) {
        const { item, workflow } = named;
        if (!requeue && !drop) {
          refuse(
            `queue item ${item.dedupKey} of ${workflow} (${item.state}) names run ${runId}: clean it with --requeue or --drop, or \`sail queue requeue|drop\``,
          );
          code = EXIT_REFUSED;
          continue;
        }
        const watching = await watcherOf(workflow);
        if ('refused' in watching) {
          refuse(`run ${runId}: ${watching.refused}`);
          code = EXIT_REFUSED;
          continue;
        }
        const checked = await commandFor(op, {
          runs,
          sailDir: project.sailDir,
          config: project.config,
          workflow,
          label: watching.label,
          ref: item.dedupKey,
        });
        if ('refused' in checked) {
          refuse(`run ${runId}: ${checked.refused}`);
          code = EXIT_REFUSED;
          continue;
        }
        settle = { item, workflow, watching, command: checked.command, key: checked.key ?? item.dedupKey };
      }

      const settling = settle;
      const cleaned = await cleanRun({
        sailDir: project.sailDir,
        runId,
        workspace: project.adapters.ports.workspace,
        queueItems: (id) => {
          const items = queueItemsNaming(runs, id);
          if ('refused' in items || settling === undefined) return items;
          return items.filter(
            (each) => !(each.workflow === settling.workflow && each.item.dedupKey === settling.item.dedupKey),
          );
        },
        codeHost,
        env,
      });
      if ('refused' in cleaned) {
        refuse(cleaned.refused);
        code = EXIT_REFUSED;
        continue;
      }
      if ('failed' in cleaned) {
        for (const failure of cleaned.failed.failures) io.stderr(`${COMMAND}: ${runId}: ${failure}\n`);
        io.stderr(`${COMMAND}: ${runId}: its run directory stays at .sail-runs/${runId}; clean it again\n`);
        failed();
        continue;
      }
      io.stdout(`${cleanedMessage(runId, cleaned.cleaned, home)}\n`);

      let ready = true;
      if (source !== undefined) {
        const reset = await resetTicket({ ticketSource: source, source: cleaned.cleaned.source, runId, runsDir: runs });
        if ('reset' in reset) io.stdout(`reset ${reset.reset.ticketKey} to ${reset.reset.state.name}\n`);
        else if ('failed' in reset) {
          const key = cleaned.cleaned.source.kind === 'ticket' ? cleaned.cleaned.source.ticketKey : runId;
          io.stderr(`${COMMAND}: ${runId}: its ticket ${key} was not reset: ${reset.failed}\n`);
          failed();
          ready = false;
        }
      }
      if (settling === undefined || !ready) continue;

      const { item, workflow, watching } = settling;
      if (drop && item.source.kind === 'ticket') {
        const problem = await removeLabel(item.source.ticketKey, watching.label);
        if (problem !== undefined) {
          io.stderr(`${COMMAND}: ${runId}: ${problem}\n`);
          failed();
          continue;
        }
      }
      const mark = streamMark(runs, workflow);
      const file = dropCommand(runs, settling.command);
      if (!(await taken(file, deps))) {
        io.stdout(
          `${COMMAND}: the watcher of '${workflow}' (pid ${watching.pid}) ${NOT_TAKEN}: it waits in ${at(io, file)}\n`,
        );
        continue;
      }
      const outcome = outcomeOf(runs, workflow, op, settling.key, mark);
      if ('refused' in outcome) {
        refuse(outcome.refused);
        code = EXIT_REFUSED;
      } else if (outcome.applied === undefined) io.stdout(`${settling.key} dropped\n`);
      else io.stdout(`requeued ${itemLine(outcome.applied)}\n`);
    }
    return code;
  };
}

export const clean = cleanCommand();
