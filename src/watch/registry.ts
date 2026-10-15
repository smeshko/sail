// The watcher registry's repository entries: one `<name>.json` per repository under `<machine dir>/watchers/`,
// versioned `sail.registry.v1`. Any command that opens a run records its repository here, so the dashboard finds
// every repository before any watcher exists.
//
// A live watcher records itself in its repository's entry, as `watcher`: its pid, the `.sail/` it watches, and the
// labels it polls on its ticket source. It writes the field as it starts and whenever its labels change, reads the
// registry again to see whether another watcher wrote meanwhile, and clears the field as it stops. A watcher whose pid
// is dead is no watcher, so a field a crash left behind holds nothing. Registration carries the field forward, so a
// run refreshing its repository's entry never erases the watcher that started it.
//
// The machine directory is `SAIL_HOME`, or `~/.sail`. Branch leases don't follow `SAIL_HOME` yet.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAlive as processIsAlive } from '../adapters/leases';
import { formatIssue, validateDocument } from '../engine/schemas';

/** A repository's live watcher, as its registry entry records it. */
export interface WatcherFields {
  pid: number;
  /** ISO 8601, UTC. */
  startedAt: string;
  /** The `.sail/` it watches, absolute. */
  sailDir: string;
  /** The `name` of its ticket source's adapter, such as `linear` or `fake`. */
  ticketSource: string;
  /** The labels its watch set polls on that ticket source. */
  labels: string[];
}

/** One repository as the registry records it. */
export interface RegistryEntry {
  schema: 'sail.registry.v1';
  /** `project.yaml`'s `name`: the key, and the file's name. */
  name: string;
  /** `remote.origin.url` without its userinfo, or null when the clone has none. */
  remote: string | null;
  /** The clone's git root, absolute. */
  clone: string;
  /** The repository's `.sail/`, absolute: `.sail-runs/` sits beside it. */
  sailDir: string;
  /** ISO 8601, UTC. */
  updatedAt: string;
  /** The repository's watcher, when one has started. Only a live pid makes it one. */
  watcher?: WatcherFields;
}

/** A registry file that can't be read as an entry, and why. `file` is its name in the registry directory. */
export interface RegistryProblem {
  file: string;
  message: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** sail's machine-level directory: `SAIL_HOME` when it is set and not empty, else `~/.sail`. */
export function machineDir(env: Env): string {
  const home = env.SAIL_HOME;
  return home === undefined || home === '' ? join(homedir(), '.sail') : home;
}

/** Where the registry's entries live, in `machineDir`. */
export function registryDir(machine: string): string {
  return join(machine, 'watchers');
}

const TEMP = /\.tmp$/;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The entry in `file`, or why it isn't one. */
function readFile(dir: string, file: string): RegistryEntry | string {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (error) {
    return `is not a registry entry: ${messageOf(error)}`;
  }
  const [issue] = validateDocument('sail.registry.v1', data);
  if (issue !== undefined) return formatIssue(issue);
  const entry = data as RegistryEntry;
  if (file !== `${entry.name}.json`) return `holds the entry of '${entry.name}', which belongs in ${entry.name}.json`;
  return entry;
}

/**
 * Every entry in `dir`, sorted by name, and every file that isn't one. A missing directory is an empty registry, and
 * temp files are left out. Nothing here throws for a bad file.
 */
export function readRegistry(dir: string): { entries: RegistryEntry[]; problems: RegistryProblem[] } {
  const entries: RegistryEntry[] = [];
  const problems: RegistryProblem[] = [];
  if (!existsSync(dir)) return { entries, problems };
  for (const file of readdirSync(dir).sort()) {
    if (TEMP.test(file) || !file.endsWith('.json')) continue;
    const read = readFile(dir, file);
    if (typeof read === 'string') problems.push({ file, message: read });
    else entries.push(read);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
  return { entries, problems };
}

/** The valid entry recorded for `name`, or undefined. */
export function readEntry(dir: string, name: string): RegistryEntry | undefined {
  const file = `${name}.json`;
  if (!existsSync(join(dir, file))) return undefined;
  const read = readFile(dir, file);
  return typeof read === 'string' ? undefined : read;
}

/** Records `entry` as `<dir>/<name>.json`, replacing any before it: a temp file, then a rename. Creates `dir`. */
export function recordEntry(dir: string, entry: RegistryEntry): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${entry.name}.json`);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`);
  renameSync(temp, path);
}

/** Whether a pid names a live process. */
export type IsAlive = (pid: number) => boolean;

/** The entry's watcher, when its pid is alive. */
export function liveWatcher(entry: RegistryEntry, isAlive: IsAlive = processIsAlive): WatcherFields | undefined {
  const { watcher } = entry;
  return watcher !== undefined && isAlive(watcher.pid) ? watcher : undefined;
}

/** A watcher looking for what holds its name or its labels: its repository's `name`, and its own fields. */
export type WatcherClaim = Pick<WatcherFields, 'pid' | 'sailDir' | 'ticketSource' | 'labels'> & { name: string };

/**
 * A live watcher in the way of `me`: of `me.name` in another `.sail/` (`name`), of `me.name` in `me.sailDir` with
 * another pid (`here`), or polling a label of `me` on the same ticket source (`label`).
 */
export type Holder =
  | { kind: 'name'; entry: RegistryEntry; watcher: WatcherFields }
  | { kind: 'here'; entry: RegistryEntry; watcher: WatcherFields }
  | { kind: 'label'; label: string; entry: RegistryEntry; watcher: WatcherFields };

/** The first live watcher in `entries` that holds `me`'s name or one of its labels, the name first. */
export function findHolder(
  entries: readonly RegistryEntry[],
  me: WatcherClaim,
  isAlive: IsAlive = processIsAlive,
): Holder | undefined {
  const live = entries.flatMap((entry) => {
    const watcher = liveWatcher(entry, isAlive);
    return watcher === undefined || watcher.pid === me.pid ? [] : [{ entry, watcher }];
  });
  const named = live.find(({ entry }) => entry.name === me.name);
  if (named !== undefined) return { kind: named.watcher.sailDir === me.sailDir ? 'here' : 'name', ...named };
  for (const { entry, watcher } of live) {
    if (watcher.ticketSource !== me.ticketSource) continue;
    const label = me.labels.find((each) => watcher.labels.includes(each));
    if (label !== undefined) return { kind: 'label', label, entry, watcher };
  }
  return undefined;
}

/**
 * Records `me` as the live watcher in `entry`, unless a live watcher holds its name or a label: it reads the registry,
 * refuses on a holder, writes the entry with its field, and reads again. A holder that wrote meanwhile makes it put
 * the entry's field back as it was, and refuse. Two watchers that start at the same instant may then both refuse, and
 * never both run.
 */
export function claimWatcher(
  dir: string,
  entry: RegistryEntry,
  me: WatcherFields,
  isAlive: IsAlive = processIsAlive,
): { claimed: true } | { holder: Holder } {
  const claim: WatcherClaim = { name: entry.name, ...me };
  const before = readRegistry(dir).entries;
  const held = findHolder(before, claim, isAlive);
  if (held !== undefined) return { holder: held };
  const previous = before.find((each) => each.name === entry.name)?.watcher;
  const { watcher: _, ...fields } = entry;
  recordEntry(dir, { ...fields, watcher: me });
  const after = findHolder(readRegistry(dir).entries, claim, isAlive);
  if (after === undefined) return { claimed: true };
  const now = readEntry(dir, entry.name);
  if (now?.watcher?.pid === me.pid) {
    const { watcher: __, ...rest } = now;
    recordEntry(dir, previous?.pid === me.pid ? { ...rest, watcher: previous } : rest);
  }
  return { holder: after };
}

/** Drops the `watcher` field from `name`'s entry, only while it is `pid`'s. */
export function clearWatcher(dir: string, name: string, pid: number): void {
  const entry = readEntry(dir, name);
  if (entry?.watcher?.pid !== pid) return;
  const { watcher: _, ...rest } = entry;
  recordEntry(dir, rest);
}

/**
 * `url` without its userinfo: `https://user:token@host/o/r` is `https://host/o/r`. The userinfo runs to the authority's
 * last `@`, since a password may hold one. Any other URL, scp-style `git@host:o/r` included, is kept.
 */
export function withoutUserinfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1');
}

/** The git variables that would point git somewhere other than `cwd`. */
const LOCATION = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];

/** The clone's `remote.origin.url`, without its userinfo, or null when it has none or git fails. */
export async function cloneRemote(clone: string, env: Env): Promise<string | null> {
  const spawnEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !LOCATION.includes(key)) spawnEnv[key] = value;
  }
  try {
    const git = Bun.spawn(['git', 'config', '--get', 'remote.origin.url'], {
      cwd: clone,
      env: spawnEnv,
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 5000,
    });
    const [out, code] = await Promise.all([new Response(git.stdout).text(), git.exited]);
    const url = out.trim();
    return code === 0 && url !== '' ? withoutUserinfo(url) : null;
  } catch {
    return null;
  }
}
