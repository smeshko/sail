// The watcher registry's repository entries: one `<name>.json` per repository under `<machine dir>/watchers/`,
// versioned `sail.registry.v1`. Any command that opens a run records its repository here, so the dashboard finds
// every repository before any watcher exists. The watcher adds its pid and labels later.
//
// The machine directory is `SAIL_HOME`, or `~/.sail`. Branch leases don't follow `SAIL_HOME` yet.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatIssue, validateDocument } from '../engine/schemas';

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

/** `url` without its userinfo: `https://user:token@host/o/r` is `https://host/o/r`. Any other URL is kept. */
export function withoutUserinfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
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
