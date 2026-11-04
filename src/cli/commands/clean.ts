// `sail clean <run>... | --failed [--all-repos] [--requeue|--drop]`: removes each failed run's worktree, branches and run ref, and
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
// nothing: dispatch would only drop a requeued ticket still In Progress. A reset or label removal that fails after the
// archive says the `sail queue requeue|drop` that settles the item by hand, since a second clean no longer lists the run.
//
// --all-repos (with --failed) does so for every repository in the machine's registry, from any directory: each is loaded
// from its registered clone, its lines are prefixed `<name>: `, and its watcher is the one the registry records. A clone
// that is gone is reported and skipped, a repository whose config or adapters have issues is refused (exit 3), and one
// with no failed run says nothing.
//
// Exit 3 when any run was refused, else 1 when any removal failed, else 0. Each run is cleaned in turn, whatever the
// ones before it came to.
import { existsSync } from 'node:fs';
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
import { type Holder, liveSet, liveWatcher, machineDir, readRegistry, registryDir } from '../../watch/registry';
import { holderRefusal } from '../../watch/watcher';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED, type ExitCode } from '../exit-codes';
import type { Command, Io } from '../index';
import { at, findProject, refuseAs } from './run-workflow';
import { findWatcher, taken, type WatchDeps } from './watch';

const COMMAND = 'sail clean';
type Project = Exclude<Awaited<ReturnType<typeof findProject<'workspace'>>>, number>;
type WatcherLocator = () => Promise<{ name: string; holder: Holder | undefined }>;
const USAGE = 'usage: sail clean <run>... | --failed [--all-repos] [--requeue|--drop]';

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

interface Repository {
  io: Io;
  project: Project;
  runIds: string[];
  /** `<name>: ` on every line when several repositories are cleaned, else empty. */
  prefix: string;
  requeue: boolean;
  drop: boolean;
  deps: WatchDeps;
  locate: WatcherLocator;
}

async function cleanRepository(repository: Repository): Promise<ExitCode> {
  const { io, project, runIds, prefix, requeue, drop, deps, locate } = repository;
  const env = io.env ?? process.env;
  const say = (line: string): void => io.stdout(`${prefix}${line}\n`);
  const warn = (line: string): void => io.stderr(`${COMMAND}: ${prefix}${line}\n`);
  const refused = (line: string): void => warn(line);
  const runs = runsDir(project.sailDir);

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

  let found: ReturnType<WatcherLocator> | undefined;
  const watcherOf = async (workflow: string): Promise<Watching | { refused: string }> => {
    found ??= locate();
    const { name, holder } = await found;
    if (holder?.kind === 'name') return { refused: holderRefusal(holder, name) };
    if (holder?.kind !== 'here') {
      return { refused: `no watcher is running for '${name}' here: sail watch ${workflow} first` };
    }
    const { pid } = holder.watcher;
    const watched = liveSet(project.sailDir, pid).find((each) => each.workflow === workflow);
    if (watched === undefined) {
      return { refused: `the watcher of '${name}' (pid ${pid}) does not watch '${workflow}'` };
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
        refused(`run ${runId}: its ticket can't be reset: ${resolved.refused}`);
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
        refused(
          `queue item ${item.dedupKey} of ${workflow} (${item.state}) names run ${runId}: clean it with --requeue or --drop, or \`sail queue requeue|drop\``,
        );
        code = EXIT_REFUSED;
        continue;
      }
      const watching = await watcherOf(workflow);
      if ('refused' in watching) {
        refused(`run ${runId}: ${watching.refused}`);
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
        refused(`run ${runId}: ${checked.refused}`);
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
      refused(cleaned.refused);
      code = EXIT_REFUSED;
      continue;
    }
    if ('failed' in cleaned) {
      for (const failure of cleaned.failed.failures) warn(`${runId}: ${failure}`);
      warn(`${runId}: its run directory stays at .sail-runs/${runId}; clean it again`);
      failed();
      continue;
    }
    say(`${cleanedMessage(runId, cleaned.cleaned, home)}`);

    let ready = true;
    if (source !== undefined) {
      const reset = await resetTicket({ ticketSource: source, source: cleaned.cleaned.source, runId, runsDir: runs });
      if ('reset' in reset) say(`reset ${reset.reset.ticketKey} to ${reset.reset.state.name}`);
      else if ('failed' in reset) {
        const key = cleaned.cleaned.source.kind === 'ticket' ? cleaned.cleaned.source.ticketKey : runId;
        warn(`${runId}: its ticket ${key} was not reset: ${reset.failed}`);
        failed();
        ready = false;
      }
    }
    if (settling === undefined) continue;
    const { item, workflow, watching } = settling;
    const unsettled = (): void =>
      warn(
        `${runId}: queue item ${item.dedupKey} of ${workflow} still names it: settle it with \`sail queue ${op} ${workflow} ${item.dedupKey}\``,
      );
    if (!ready) {
      unsettled();
      continue;
    }

    if (drop && item.source.kind === 'ticket') {
      const problem = await removeLabel(item.source.ticketKey, watching.label);
      if (problem !== undefined) {
        warn(`${runId}: ${problem}`);
        unsettled();
        failed();
        continue;
      }
    }
    const mark = streamMark(runs, workflow);
    const file = dropCommand(runs, settling.command);
    if (!(await taken(file, deps))) {
      io.stdout(
        `${COMMAND}: ${prefix}the watcher of '${workflow}' (pid ${watching.pid}) ${NOT_TAKEN}: it waits in ${at(io, file)}\n`,
      );
      continue;
    }
    const outcome = outcomeOf(runs, workflow, op, settling.key, mark);
    if ('refused' in outcome) {
      refused(outcome.refused);
      code = EXIT_REFUSED;
    } else if (outcome.applied === undefined) say(`${settling.key} dropped`);
    else say(`requeued ${itemLine(outcome.applied)}`);
  }
  return code;
}

export function cleanCommand(deps: WatchDeps = {}): Command {
  return async (args, io) => {
    const refuse = refuseAs(io, COMMAND);
    const failedOnly = args.values.failed === true;
    const allRepos = args.values['all-repos'] === true;
    const requeue = args.values.requeue === true;
    const drop = args.values.drop === true;
    if (failedOnly === args.positionals.length > 0 || (requeue && drop) || (allRepos && !failedOnly)) {
      return refuse(USAGE);
    }
    const isAlive = deps.isAlive ?? processIsAlive;
    const failedRuns = (project: Project): string[] =>
      listRuns(project.sailDir)
        .filter((listed) => listed.status?.status === 'failed')
        .map((listed) => listed.runId);

    if (!allRepos) {
      const project = await findProject(io, COMMAND, { ports: ['workspace'] });
      if (typeof project === 'number') return project;
      const runIds = failedOnly ? failedRuns(project) : [...new Set(args.positionals)];
      if (runIds.length === 0) {
        io.stderr(`${COMMAND}: no failed runs\n`);
        return EXIT_OK;
      }
      const locate: WatcherLocator = async () => {
        const { entry, holder } = await findWatcher(io, project, isAlive);
        return { name: entry.name, holder };
      };
      return cleanRepository({ io, project, runIds, prefix: '', requeue, drop, deps, locate });
    }

    const registry = readRegistry(registryDir(machineDir(io.env ?? process.env)));
    for (const problem of registry.problems) io.stderr(`${COMMAND}: ${problem.file}: ${problem.message}\n`);
    let code: ExitCode = EXIT_OK;
    let any = false;
    for (const entry of registry.entries) {
      if (!existsSync(entry.clone) || !existsSync(entry.sailDir)) {
        const missing = existsSync(entry.clone) ? `its .sail/ ${entry.sailDir}` : `its clone ${entry.clone}`;
        io.stderr(`${COMMAND}: ${entry.name}: ${missing} is missing: skipped\n`);
        continue;
      }
      const project = await findProject(io, COMMAND, {
        found: { dir: entry.sailDir },
        root: entry.clone,
        label: `${entry.name}'s project.yaml`,
        ports: ['workspace'],
      });
      if (typeof project === 'number') {
        code = EXIT_REFUSED;
        continue;
      }
      const runIds = failedRuns(project);
      if (runIds.length === 0) continue;
      any = true;
      const locate: WatcherLocator = async () => {
        const watcher = liveWatcher(entry, isAlive);
        if (watcher === undefined) return { name: entry.name, holder: undefined };
        const kind = watcher.sailDir === entry.sailDir ? 'here' : 'name';
        return { name: entry.name, holder: { kind, entry, watcher } };
      };
      const result = await cleanRepository({
        io,
        project,
        runIds,
        prefix: `${entry.name}: `,
        requeue,
        drop,
        deps,
        locate,
      });
      if (result === EXIT_REFUSED || code === EXIT_OK) code = result;
    }
    if (!any && code === EXIT_OK) io.stderr(`${COMMAND}: no failed runs\n`);
    return code;
  };
}

export const clean = cleanCommand();
