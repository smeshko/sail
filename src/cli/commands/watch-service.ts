// `sail watch --install`, `--uninstall` and `--restart`: the watcher as a login service, a launchd agent per repository
// (macOS only; see `service.ts`). `watchCommand()` calls `serviceCommand()` before anything else.
//
// - `--install [<workflow>...]` writes and loads `sail.watcher.<name>`, whose arguments are `watch --service` and the
//   names, in this clone. It refuses a name that is no watched workflow, no names with no watched workflow, and a live
//   watcher of the repository that no installed agent could own (none is installed): it names its pid and
//   `sail unwatch`, so the agent doesn't loop on "a live watcher in the way".
// - `--install --all` installs one agent, with no names, for each registry entry whose `.sail/` still declares a watch,
//   and prints one line for each entry it skips, with the reason.
// - `--uninstall [--all]` unloads the agent of this repository, or every installed one, and deletes its plist.
// - `--restart [<repository>|--all]`: see its own branch below.
//
// At most one of the three is taken; then the platform is checked, then, for `--restart` and `--uninstall`, that an agent
// is installed, so a refusal never reaches `launchctl`. Every refusal is exit code 3.
import { existsSync } from 'node:fs';
import { isAlive as processIsAlive } from '../../adapters/leases';
import { readConfig } from '../../engine/config';
import { readWatch, readWatches } from '../../watch/poll';
import { liveWatcher, machineDir, readEntry, readRegistry, registryDir as registryDirOf } from '../../watch/registry';
import { EXIT_OK, EXIT_REFUSED, type ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';
import { repositoryEntry } from '../registration';
import {
  agentEnvironment,
  installAgent,
  installedWatchers,
  logPath,
  platformRefusal,
  plistPath,
  type ServiceDeps,
  serviceDeps,
  uninstallAgent,
  watcherLabel,
} from '../service';
import { findProject, refuseAs } from './run-workflow';
import type { WatchDeps } from './watch';

const COMMAND = 'sail watch';

/** The line `--restart` and `--uninstall` refuse with when nothing is installed for `name`, or at all. */
const notInstalled = (name?: string): string =>
  name === undefined
    ? `no login service is installed: ${COMMAND} --install installs one`
    : `no login service is installed for '${name}': ${COMMAND} --install installs it`;

/**
 * Handles `--install`, `--uninstall` and `--restart`: the exit code, or undefined when none of them is given.
 */
export async function serviceCommand(
  deps: WatchDeps,
  args: Parsed,
  io: Io,
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<ExitCode | undefined> {
  const refuse = refuseAs(io, COMMAND);
  const wanted = (['install', 'uninstall', 'restart'] as const).filter((option) => args.values[option] === true);
  const all = args.values.all === true;
  if (wanted.length === 0) return all ? refuse('--all goes with --install, --uninstall or --restart') : undefined;
  if (wanted.length > 1) return refuse('take one of --install, --uninstall and --restart');
  const env = io.env ?? process.env;
  const service = serviceDeps(env, deps.service);
  const platform = platformRefusal(service.platform);
  if (platform !== undefined) return refuse(platform);
  const names = [...new Set(args.positionals)];
  const operation = wanted[0];
  if (operation === 'install')
    return all ? installAll(deps, service, names, io, isAlive) : install(service, names, io, isAlive);
  if (operation === 'uninstall') return uninstall(service, all, names, io);
  return refuse('--restart is not available yet');
}

/** Installs this clone's watcher agent. */
async function install(
  service: ServiceDeps,
  names: string[],
  io: Io,
  isAlive: (pid: number) => boolean,
): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  const project = await findProject(io, COMMAND, { ports: [] });
  if (typeof project === 'number') return project;
  const { sailDir, config } = project;
  if (names.length === 0) {
    const read = await readWatches({ sailDir, config });
    if ('refused' in read) return refuse(read.refused);
    if (read.watches.length === 0) return refuse('no workflow declares a watch');
  } else {
    for (const name of names) {
      const watch = await readWatch({ sailDir, config, name });
      if ('refused' in watch) return refuse(watch.refused);
    }
  }
  const entry = await repositoryEntry(io, project);
  const label = watcherLabel(entry.name);
  const recorded = readEntry(registryDirOf(machineDir(io.env ?? process.env)), entry.name);
  const live = recorded === undefined ? undefined : liveWatcher(recorded, isAlive);
  if (live !== undefined && !existsSync(plistPath(service.home, label))) {
    return refuse(
      `a watcher for '${entry.name}' already runs outside launchd (pid ${live.pid}): sail unwatch stops it first`,
    );
  }
  const result = await installAgent(service, {
    label,
    args: ['watch', '--service', ...names],
    workingDirectory: entry.clone,
    environment: agentEnvironment(io.env ?? process.env),
    log: logPath(machineDir(io.env ?? process.env), label),
  });
  if ('refused' in result) return refuse(result.refused);
  io.stdout(installedLine(label, result));
  return EXIT_OK;
}

const installedLine = (label: string, result: { plist: string; log: string }): string =>
  `${COMMAND}: installed the login service '${label}' (${result.plist}); its log is ${result.log}; it reads its credentials from the keychain and gh auth token\n`;

/** Installs one agent for each registered repository that declares a watch. */
async function installAll(
  _deps: WatchDeps,
  service: ServiceDeps,
  names: string[],
  io: Io,
  isAlive: (pid: number) => boolean,
): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  if (names.length > 0) return refuse('--all takes no workflow');
  const env = io.env ?? process.env;
  const skipped = (name: string, why: string) => io.stdout(`${COMMAND}: skipped '${name}': ${why}\n`);
  let failed = false;
  for (const entry of readRegistry(registryDirOf(machineDir(env))).entries) {
    const label = watcherLabel(entry.name);
    if (!existsSync(entry.sailDir)) {
      skipped(entry.name, `${entry.sailDir} is gone`);
      continue;
    }
    const config = readConfig(entry.sailDir);
    if ('issues' in config) {
      skipped(entry.name, `its project.yaml is invalid: ${config.issues[0]?.message ?? 'see sail check'}`);
      continue;
    }
    const read = await readWatches({ sailDir: entry.sailDir, config });
    if ('refused' in read) {
      skipped(entry.name, read.refused);
      continue;
    }
    if (read.watches.length === 0) {
      skipped(entry.name, 'no workflow declares a watch');
      continue;
    }
    const live = liveWatcher(entry, isAlive);
    if (live !== undefined && !existsSync(plistPath(service.home, label))) {
      skipped(entry.name, `a watcher already runs outside launchd (pid ${live.pid})`);
      continue;
    }
    const result = await installAgent(service, {
      label,
      args: ['watch', '--service'],
      workingDirectory: entry.clone,
      environment: agentEnvironment(env),
      log: logPath(machineDir(env), label),
    });
    if ('refused' in result) {
      io.stderr(`${COMMAND}: '${entry.name}': ${result.refused}\n`);
      failed = true;
    } else {
      io.stdout(installedLine(label, result));
    }
  }
  return failed ? EXIT_REFUSED : EXIT_OK;
}

/** Unloads this clone's watcher agent, or with `all` every installed one, and deletes the plists. */
async function uninstall(service: ServiceDeps, all: boolean, names: string[], io: Io): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  if (all) {
    if (names.length > 0) return refuse('--all takes no workflow');
    const installed = installedWatchers(service.home);
    if (installed.length === 0) return refuse(notInstalled());
    let failed = false;
    for (const name of installed) {
      const result = await uninstallAgent(service, watcherLabel(name), notInstalled(name));
      if ('refused' in result) {
        io.stderr(`${COMMAND}: ${result.refused}\n`);
        failed = true;
      } else {
        io.stdout(`${COMMAND}: uninstalled the login service '${watcherLabel(name)}'\n`);
      }
    }
    return failed ? EXIT_REFUSED : EXIT_OK;
  }
  const project = await findProject(io, COMMAND, { ports: [] });
  if (typeof project === 'number') return project;
  const { name } = project.config;
  const result = await uninstallAgent(service, watcherLabel(name), notInstalled(name));
  if ('refused' in result) return refuse(result.refused);
  io.stdout(`${COMMAND}: uninstalled the login service '${watcherLabel(name)}'\n`);
  return EXIT_OK;
}
