// The watcher registry's repository entries: one `<name>.json` per repository under `<machine dir>/watchers/`,
// versioned `sail.registry.v1`. Any command that opens a run records its repository here, so the dashboard finds
// every repository before any watcher exists.
//
// A live watcher records itself in its repository's entry, as `watcher`: its pid, the `.sail/` it watches, and the
// labels it polls, compared on the same ticket source and scope. It writes the field as it starts and whenever its
// labels change, reads the
// registry again to see whether another watcher wrote meanwhile, and clears the field as it stops. A watcher whose pid
// is dead is no watcher, so a field a crash left behind holds nothing. Registration carries the field forward, so a
// run refreshing its repository's entry never erases the watcher that started it.
//
// The machine directory is `SAIL_HOME`, or `~/.sail`; branch leases and exclusive slots live there too.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive as processIsAlive } from '../adapters/leases';
import { runsDir } from '../engine/run-dir';
import { formatIssue, validateDocument } from '../engine/schemas';
import type { TicketSource } from '../ports/ticket-source';
import { QUEUE_DIR } from './queue-store';

/** The adapter and scope that share a watcher's label space. */
export function ticketSourceKey(source: Pick<TicketSource, 'name' | 'scope'>): string {
  return source.scope === undefined || source.scope === '' ? source.name : `${source.name}:${source.scope}`;
}

/** A repository's live watcher, as its registry entry records it. */
export interface WatcherFields {
  pid: number;
  /** ISO 8601, UTC. */
  startedAt: string;
  /** The `.sail/` it watches, absolute. */
  sailDir: string;
  /**
   * Its ticket source's adapter `name` with its scope, such as `linear:ADW`, or the name alone, such as `fake`,
   * for a source with no scope.
   */
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

export { machineDir } from '../engine/machine-dir';

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

/** A workflow in the live watcher's set: its name, its label and when it was added. */
export interface Watched {
  workflow: string;
  label: string;
  seq: number;
  ts: string;
}

/** The live watcher's set, read from the queue event streams beside `sailDir`, in the order it was formed. */
export function liveSet(sailDir: string, pid: number): Watched[] {
  const dir = join(runsDir(sailDir), QUEUE_DIR);
  if (!existsSync(dir)) return [];
  const set: Watched[] = [];
  for (const workflow of readdirSync(dir)) {
    const file = join(dir, workflow, 'events.ndjson');
    if (!existsSync(file)) continue;
    let last: Record<string, unknown> | undefined;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // The live watcher's own events: one that lost the registry to it may have written after them (keepWatcher).
      if ((event.type === 'watch:added' || event.type === 'watch:removed') && event.pid === pid) last = event;
    }
    if (last?.type === 'watch:added') {
      set.push({ workflow, label: String(last.label), seq: Number(last.seq), ts: String(last.ts) });
    }
  }
  return set.sort((a, b) => a.ts.localeCompare(b.ts) || a.workflow.localeCompare(b.workflow));
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

const sameWatcher = (a: WatcherFields, b: WatcherFields) =>
  a.pid === b.pid &&
  a.startedAt === b.startedAt &&
  a.sailDir === b.sailDir &&
  a.ticketSource === b.ticketSource &&
  a.labels.join('\n') === b.labels.join('\n');

/**
 * Keeps `me` as the watcher recorded in `entry`'s file, as a live watcher checks on every tick. Two watchers of one
 * name write one file, so the read-back of `claimWatcher()` can't see a second claim that lands after it: the field a
 * live watcher of another pid holds says this one lost, and it is answered (`lost`), and nothing is written. A field
 * that is missing, dead or not as `me` has it, as a registration that read the entry before the watcher wrote it leaves
 * it, is claimed again with `claimWatcher()`, unless a live watcher of another repository took one of its labels while
 * it was wrong: that holder is answered, and the field is left as it was.
 */
export function keepWatcher(
  dir: string,
  entry: RegistryEntry,
  me: WatcherFields,
  isAlive: IsAlive = processIsAlive,
): { kept: true } | { lost: WatcherFields } | { holder: Holder } {
  const now = readEntry(dir, entry.name);
  const held = now?.watcher;
  if (held !== undefined && held.pid !== me.pid && isAlive(held.pid)) return { lost: held };
  if (held !== undefined && sameWatcher(held, me)) return { kept: true };
  // The repair is a claim: it writes, then reads again, so another repository claiming a label meanwhile is seen by
  // one of the two at least.
  const claimed = claimWatcher(dir, now !== undefined && now.sailDir === entry.sailDir ? now : entry, me, isAlive);
  return 'holder' in claimed ? claimed : { kept: true };
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
