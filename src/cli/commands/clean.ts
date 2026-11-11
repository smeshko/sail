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
import { isAlive as processIsAlive } from '../../adapters/leases';
import { listRuns } from '../../engine/runs';
import { cleanRuns, lazyPorts, locateRegistered, type WatcherLocator } from '../../watch/clean-runs';
import { machineDir, readRegistry, registryDir } from '../../watch/registry';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED, type ExitCode } from '../exit-codes';
import type { Command, Io } from '../index';
import { at, findProject, refuseAs } from './run-workflow';
import { findWatcher, taken, type WatchDeps } from './watch';

const COMMAND = 'sail clean';
type Project = Exclude<Awaited<ReturnType<typeof findProject<'workspace'>>>, number>;
const USAGE = 'usage: sail clean <run>... | --failed [--all-repos] [--requeue|--drop]';

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
  const cleaned = await cleanRuns({
    sailDir: project.sailDir,
    config: project.config,
    workspace: project.adapters.ports.workspace,
    ...lazyPorts({ sailDir: project.sailDir, config: project.config, env }),
    env,
    runIds,
    ...(requeue ? { settle: 'requeue' as const } : drop ? { settle: 'drop' as const } : {}),
    locate,
    taken: (file) => taken(file, deps),
    showPath: (file) => at(io, file),
    onLine: (_runId, line) => {
      if (line.kind === 'said') io.stdout(`${prefix}${line.text}\n`);
      else if (line.kind === 'warned') io.stderr(`${COMMAND}: ${prefix}${line.text}\n`);
      else io.stdout(`${COMMAND}: ${prefix}${line.text}\n`);
    },
  });
  if (cleaned.some((each) => each.problem === 'refused')) return EXIT_REFUSED;
  if (cleaned.some((each) => each.problem === 'failed')) return EXIT_FAILED;
  return EXIT_OK;
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
      const locate = locateRegistered(entry, isAlive);
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
