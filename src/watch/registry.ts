// The watcher registry's repository entries. A stub: the signatures are final, and every answer is wrong until
// ADW-120's first task.
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export function machineDir(_env: Env): string {
  return join(homedir(), '.sail');
}

export function registryDir(machine: string): string {
  return join(machine, 'watchers');
}

export function readRegistry(_dir: string): { entries: RegistryEntry[]; problems: RegistryProblem[] } {
  return { entries: [], problems: [] };
}

export function readEntry(_dir: string, _name: string): RegistryEntry | undefined {
  return undefined;
}

export function recordEntry(_dir: string, _entry: RegistryEntry): void {}

export function withoutUserinfo(url: string): string {
  return url;
}

export async function cloneRemote(clone: string, _env: Env): Promise<string | null> {
  return clone;
}
