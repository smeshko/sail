// Registration: `sail <ticket>` and `sail resume` record their repository in the watcher registry just before the run
// opens, so the dashboard finds it before any watcher exists. The dashboard is optional, so nothing here fails a run:
// a registry that can't be written is a warning.
//
// Another clone may hold the same `name`. When that clone still exists and has another remote, the command warns, and
// this clone takes the entry: the dashboard shows this clone's runs. A stale entry, whose `.sail/` is gone, is replaced
// without a word.
import { existsSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProjectConfig } from '../engine/config';
import { findGitRoot } from '../engine/sail-dir';
import { cloneRemote, machineDir, readEntry, recordEntry, registryDir } from '../watch/registry';
import type { Io } from './index';

const shown = (remote: string | null) => remote ?? 'no remote';

/** Records or refreshes the repository of `sailDir` in the registry. Warns on stderr, and never throws. */
export async function registerRepository(
  io: Io,
  command: string,
  project: { sailDir: string; config: ProjectConfig },
): Promise<void> {
  const env = io.env ?? process.env;
  const dir = registryDir(machineDir(env));
  try {
    const sailDir = realpathSync(project.sailDir);
    const clone = findGitRoot(sailDir) ?? dirname(sailDir);
    const remote = await cloneRemote(clone, env);
    const { name } = project.config;
    const before = readEntry(dir, name);
    if (before !== undefined && before.clone !== clone && before.remote !== remote && existsSync(before.sailDir)) {
      io.stderr(
        `${command}: warning: '${name}' was registered from ${before.clone} (${shown(before.remote)}); ${clone} (${shown(remote)}) now replaces it, and the dashboard shows this clone's runs\n`,
      );
    }
    recordEntry(dir, { schema: 'sail.registry.v1', name, remote, clone, sailDir, updatedAt: new Date().toISOString() });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    io.stderr(`${command}: warning: could not record this repository in ${dir}: ${why}\n`);
  }
}
