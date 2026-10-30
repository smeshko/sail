// `sail watch [<workflow>...]` and `sail unwatch [<workflow>...]`: the watch set of this repository's watcher (ADR-0019).
//
// | | No live watcher here | A live watcher here |
// |---|---|---|
// | `sail watch` | starts the watcher in the foreground, watching the workflows named, or with none named every workflow that declares a watch | hands it a `watch` command, waits for it, and prints the set |
// | `sail unwatch` | refused: nothing to unwatch | hands it an `unwatch` command, with no names for every workflow it watches, waits for it, and prints the set, or that the watcher stops |
//
// A live watcher is one the registry records for this repository's `name` with a pid that is alive. One recorded for
// the same `name` in another clone refuses both commands. Every refusal is exit code 3: no `.sail/project.yaml`, no
// workflow that declares a watch (`sail watch` with no names), a name or a workflow that isn't a watched workflow or won't load, two workflows on one label (the live set's included), a live watcher
// in the way, named with its clone and pid, or a model alias whose harness can't run its model.
//
// A watcher starts only when every model alias's harness can run its model, and pauses its dispatch while an edit of
// project.yaml names one it can't: `configChecker()` answers both, asking each harness only when the file changed.
// The watcher runs until its set empties, or until Ctrl-C or SIGTERM, and exits 0 either way. Its runs carry on.
//
// A second command waits up to 15 s for the watcher to take its command. One it hasn't taken by then stays in the
// inbox, which a watcher stopped meanwhile empties at its next start, and the command exits 0 saying so. The set it
// prints is read back from the queue event streams: each workflow whose last `watch:*` event of the live watcher's pid
// is `watch:added`.
//
// `sail queue` shares the live watcher's lookup and the wait for a command to be taken: `findWatcher()` and `taken()`.
// The set read back from the queue streams is `liveSet()`, which the dashboard shares too.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTINS } from '../../adapters/index';
import { isAlive as processIsAlive } from '../../adapters/leases';
import { checkModelAliases } from '../../engine/adapters';
import { type ProjectConfig, type RunPort, readConfig } from '../../engine/config';
import { runsDir as runsDirOf } from '../../engine/run-dir';
import { formatIssue } from '../../engine/schemas';
import { sameLabel } from '../../ports/labels';
import { dropCommand } from '../../watch/inbox';
import { readWatch, readWatches, systemTimers, type Timers, type WatchDeclaration } from '../../watch/poll';
import {
  findHolder,
  type Holder,
  type IsAlive,
  liveSet,
  machineDir,
  type RegistryEntry,
  readRegistry,
  registryDir as registryDirOf,
} from '../../watch/registry';
import type { SpawnedRun, SpawnResumeOptions, SpawnRunOptions } from '../../watch/spawn';
import { holderRefusal, startWatcher } from '../../watch/watcher';
import { EXIT_OK, type ExitCode } from '../exit-codes';
import type { Command, Io, Parsed } from '../index';
import { repositoryEntry } from '../registration';
import { at, findProject, refuseAs } from './run-workflow';

/** What the commands run on: the system's unless a test hands its own. */
export interface WatchDeps {
  timers?: Timers;
  now?: () => Date;
  spawn?: (options: SpawnRunOptions) => SpawnedRun;
  resume?: (options: SpawnResumeOptions) => SpawnedRun;
  isAlive?: IsAlive;
  tickMs?: number;
  /** How long a second command waits for the watcher to take its command. */
  applyTimeoutMs?: number;
  /** How often it looks. */
  pollMs?: number;
  /** The pid a watcher this command starts records itself under. */
  pid?: number;
}

const APPLY_TIMEOUT_MS = 15_000;
const POLL_MS = 100;

/** The environment without its unset variables, for the runs the watcher spawns. */
function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

interface Located {
  project: Exclude<Awaited<ReturnType<typeof findProject<RunPort>>>, ExitCode>;
  names: string[];
  registryDir: string;
  entry: Awaited<ReturnType<typeof repositoryEntry>>;
  /** The live watcher of this repository's `name` in this `.sail/`, when there is one. */
  live: Holder | undefined;
}

/**
 * This repository's registry entry, and the live watcher recorded for its name, with where it runs: here, or in
 * another clone. Undefined when none is alive.
 */
export async function findWatcher(
  io: Io,
  project: { sailDir: string; config: ProjectConfig },
  isAlive: IsAlive,
): Promise<{ entry: RegistryEntry; registryDir: string; holder: Holder | undefined }> {
  const entry = await repositoryEntry(io, project);
  const registryDir = registryDirOf(machineDir(io.env ?? process.env));
  const me = {
    name: entry.name,
    sailDir: entry.sailDir,
    ticketSource: project.config.adapters.ticketSource.use,
    labels: [],
    pid: process.pid,
  };
  return { entry, registryDir, holder: findHolder(readRegistry(registryDir).entries, me, isAlive) };
}

/** The names to act on when none are typed, or why there are none. */
type ResolveNames = (project: Located['project']) => Promise<string[] | { refused: string }>;

/**
 * `.sail/`, the names, and the live watcher, or a refusal: no names `resolve` can supply, or a watcher of this name in
 * another clone. With no `resolve`, an empty list of names passes through.
 */
async function locate(
  io: Io,
  command: string,
  args: Parsed,
  isAlive: IsAlive,
  resolve?: ResolveNames,
): Promise<Located | ExitCode> {
  const refuse = refuseAs(io, command);
  const project = await findProject(io, command);
  if (typeof project === 'number') return project;
  let names = [...new Set(args.positionals)];
  if (names.length === 0 && resolve !== undefined) {
    const resolved = await resolve(project);
    if ('refused' in resolved) return refuse(resolved.refused);
    names = resolved;
  }
  const { entry, registryDir, holder } = await findWatcher(io, project, isAlive);
  if (holder?.kind === 'name') return refuse(holderRefusal(holder, entry.name));
  return { project, names, registryDir, entry, live: holder?.kind === 'here' ? holder : undefined };
}

/** Waits for the watcher to take the command in `file`: true once the file is gone, false after the timeout. */
export async function taken(file: string, deps: WatchDeps): Promise<boolean> {
  const deadline = performance.now() + (deps.applyTimeoutMs ?? APPLY_TIMEOUT_MS);
  while (existsSync(file)) {
    if (performance.now() > deadline) return false;
    await Bun.sleep(deps.pollMs ?? POLL_MS);
  }
  return true;
}

/**
 * Why the runs can't start on `sailDir`'s project.yaml as it is now: it doesn't validate, or a model alias names a
 * model its harness can't run. Undefined when they can. The answer is kept until the file's text changes.
 */
export function configChecker(io: Io, sailDir: string): () => Promise<string | undefined> {
  const path = join(sailDir, 'project.yaml');
  let seen: { text: string; problem: string | undefined } | undefined;
  return async () => {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      return `${at(io, path)} can't be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (seen?.text === text) return seen.problem;
    const file = at(io, path);
    const config = readConfig(sailDir);
    const issues =
      'issues' in config
        ? config.issues
        : await checkModelAliases({ sailDir, config, builtins: BUILTINS, env: io.env ?? process.env });
    const problem = issues.length === 0 ? undefined : issues.map((issue) => formatIssue({ ...issue, file })).join('; ');
    seen = { text, problem };
    return problem;
  };
}

/** `sail watch`, on `deps`. */
export function watchCommand(deps: WatchDeps = {}): Command {
  return async (args, io) => {
    const command = 'sail watch';
    const refuse = refuseAs(io, command);
    const isAlive = deps.isAlive ?? processIsAlive;
    const located = await locate(io, command, args, isAlive, async ({ sailDir, config }) => {
      const read = await readWatches({ sailDir, config });
      if ('refused' in read) return read;
      if (read.watches.length === 0) return { refused: 'no workflow declares a watch' };
      return read.watches.map((each) => each.workflow);
    });
    if (typeof located === 'number') return located;
    const { project, names, entry, live } = located;
    const { sailDir, config } = project;

    if (live !== undefined) {
      const { pid } = live.watcher;
      const watched = liveSet(sailDir, pid);
      const known = [...watched];
      const kinds = new Map<string, WatchDeclaration>();
      for (const name of names) {
        const watch = await readWatch({ sailDir, config, name });
        if ('refused' in watch) return refuse(watch.refused);
        if (known.some((each) => each.workflow === name)) continue;
        // One label per kind (14.2's D9): a ticket workflow and a pull-request workflow may both poll `sail`. A pull
        // request's label matches whatever its case, so a pull-request workflow's clashes with `Sail` as with `sail`.
        const clashes = (label: string) =>
          watch.kind === 'pr' ? sameLabel(label, watch.label) : label === watch.label;
        let other: (typeof known)[number] | undefined;
        for (const each of known.filter((each) => clashes(each.label))) {
          const theirs = kinds.get(each.workflow) ?? (await readWatch({ sailDir, config, name: each.workflow }));
          if ('refused' in theirs || theirs.kind === watch.kind) {
            other = each;
            break;
          }
        }
        if (other !== undefined) {
          return refuse(`workflows '${other.workflow}' and '${name}' both poll the label '${watch.label}'`);
        }
        kinds.set(name, watch);
        known.push({ workflow: name, label: watch.label, seq: 0, ts: '' });
      }
      const watcher = `the watcher of '${entry.name}' (pid ${pid})`;
      if (names.every((name) => watched.some((each) => each.workflow === name))) {
        io.stdout(`${command}: ${watcher} watches ${watched.map((each) => each.workflow).join(', ')}\n`);
        return EXIT_OK;
      }
      const file = dropCommand(runsDirOf(sailDir), { op: 'watch', workflows: names });
      if (!(await taken(file, deps))) {
        io.stdout(`${command}: ${watcher} has not taken the command yet: it waits in ${at(io, file)}\n`);
        return EXIT_OK;
      }
      const now = liveSet(sailDir, pid).map((each) => each.workflow);
      const missing = names.filter((name) => !now.includes(name));
      if (missing.length > 0) return refuse(`the watcher did not add '${missing.join("', '")}': its terminal says why`);
      io.stdout(`${command}: ${watcher} watches ${now.join(', ')}\n`);
      return EXIT_OK;
    }

    const onInterrupt = io.onInterrupt;
    if (onInterrupt === undefined) return refuse('nothing can stop it here: run it from a terminal');
    // A model no harness can run would fail every run that reaches it: the watcher refuses to start on one, and
    // pauses its dispatch while an edit of project.yaml names one.
    const checkConfig = configChecker(io, sailDir);
    const problem = await checkConfig();
    if (problem !== undefined) return refuse(problem);
    const started = await startWatcher({
      sailDir,
      config,
      adapters: project.adapters.ports,
      entry,
      registryDir: located.registryDir,
      workflows: names,
      env: definedEnv(io.env ?? process.env),
      now: deps.now ?? (() => new Date()),
      timers: deps.timers ?? systemTimers,
      ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
      ...(deps.resume === undefined ? {} : { resume: deps.resume }),
      isAlive,
      ...(deps.tickMs === undefined ? {} : { tickMs: deps.tickMs }),
      ...(deps.pid === undefined ? {} : { pid: deps.pid }),
      write: (text) => io.stdout(text),
      lines: io.tty === undefined ? {} : { tty: io.tty },
      checkConfig,
    });
    if ('refused' in started) return refuse(started.refused);
    const unregister = onInterrupt(() => {
      void started.stop();
    });
    await started.done;
    unregister();
    return EXIT_OK;
  };
}

/** `sail unwatch`, on `deps`. */
export function unwatchCommand(deps: WatchDeps = {}): Command {
  return async (args, io) => {
    const command = 'sail unwatch';
    const located = await locate(io, command, args, deps.isAlive ?? processIsAlive);
    if (typeof located === 'number') return located;
    const { project, names, entry, live } = located;
    if (live === undefined) {
      return refuseAs(io, command)(`no watcher is running for '${entry.name}' here: nothing to unwatch`);
    }
    const { pid } = live.watcher;
    const watcher = `the watcher of '${entry.name}' (pid ${pid})`;
    const workflows = names.length > 0 ? names : liveSet(project.sailDir, pid).map((each) => each.workflow);
    if (workflows.length === 0) return refuseAs(io, command)(`${watcher} watches nothing: nothing to unwatch`);
    const file = dropCommand(runsDirOf(project.sailDir), { op: 'unwatch', workflows });
    if (!(await taken(file, deps))) {
      io.stdout(`${command}: ${watcher} has not taken the command yet: it waits in ${at(io, file)}\n`);
      return EXIT_OK;
    }
    const now = liveSet(project.sailDir, pid).map((each) => each.workflow);
    io.stdout(
      now.length === 0
        ? `${command}: the watch set is empty: ${watcher} stops\n`
        : `${command}: ${watcher} watches ${now.join(', ')}\n`,
    );
    return EXIT_OK;
  };
}

export const watch = watchCommand();
export const unwatch = unwatchCommand();
