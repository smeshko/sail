// Registration: `sail <ticket>` and `sail resume` record their repository in the watcher registry just before the run
// opens, so the dashboard finds it before any watcher exists. The dashboard is optional, so nothing here fails a run:
// a registry that can't be written is a warning.
//
// Another clone may hold the same `name`. When that clone still exists and has another remote, the command warns, and
// this clone takes the entry: the dashboard shows this clone's runs. A stale entry, whose `.sail/` is gone, is replaced
// without a word. The entry's `watcher` is carried forward as it was: a run its watcher dispatched refreshes the entry
// without erasing the watcher, and only a watcher writes or clears that field.
//
// `repositoryEntry()` builds the entry both registration and `sail watch` write.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ProjectConfig } from '../engine/config';
import { findGitRoot } from '../engine/sail-dir';
import { cloneRemote, machineDir, type RegistryEntry, readEntry, recordEntry, registryDir } from '../watch/registry';
import type { Io } from './index';

const shown = (remote: string | null) => remote ?? 'no remote';

/** The registry entry of the repository of `sailDir`, as of now, with no watcher. */
export async function repositoryEntry(
  io: Io,
  project: { sailDir: string; config: ProjectConfig },
): Promise<RegistryEntry> {
  const env = io.env ?? process.env;
  // The run writes `.sail-runs/` beside the `.sail/` it was found by, so a `.sail/` that is a symlink is recorded
  // there, under its directory's real path, and not where the link leads.
  const parent = realpathSync(dirname(project.sailDir));
  const sailDir = join(parent, basename(project.sailDir));
  const clone = findGitRoot(parent) ?? parent;
  const remote = await cloneRemote(clone, env);
  const { name } = project.config;
  return { schema: 'sail.registry.v1', name, remote, clone, sailDir, updatedAt: new Date().toISOString() };
}

/** Records or refreshes the repository of `sailDir` in the registry. Warns on stderr, and never throws. */
export async function registerRepository(
  io: Io,
  command: string,
  project: { sailDir: string; config: ProjectConfig },
): Promise<void> {
  const env = io.env ?? process.env;
  const dir = registryDir(machineDir(env));
  try {
    const entry = await repositoryEntry(io, project);
    const { name, clone, remote } = entry;
    const before = readEntry(dir, name);
    if (before !== undefined && before.clone !== clone && before.remote !== remote && existsSync(before.sailDir)) {
      io.stderr(
        `${command}: warning: '${name}' was registered from ${before.clone} (${shown(before.remote)}); ${clone} (${shown(remote)}) now replaces it, and the dashboard shows this clone's runs\n`,
      );
    }
    recordEntry(dir, before?.watcher === undefined ? entry : { ...entry, watcher: before.watcher });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    io.stderr(`${command}: warning: could not record this repository in ${dir}: ${why}\n`);
  }
}
