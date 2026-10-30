// A run of a workflow that is alive in a clone without a process behind it: a copy of the golden run header with its
// workflow, ticket and branch changed, STATUS `running`, and its branch leased to this process on the fake remote. It
// stands in for a manual run that a second `sail` command or the watcher has to count, since `claim()` allows only one
// run per `.sail/` per process.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedAdapters } from '../../src/engine/adapters';
import { writeStatus } from '../../src/engine/run-dir';
import { GOLDEN_RUN } from './golden-run';

export interface LiveRunOptions {
  workflow: string;
  ticketKey: string;
  runId: string;
  adapters: ResolvedAdapters;
  /** The lease's pid. This process's by default, which is alive. */
  pid?: number;
}

export interface LiveRun {
  runDir: string;
  branch: string;
  /** Marks the lease suspended and writes STATUS `suspended interrupted`, as a run does as it suspends. */
  suspend(): Promise<void>;
  /** Releases the lease. */
  release(): Promise<void>;
}

export async function writeLiveRun(repoDir: string, options: LiveRunOptions): Promise<LiveRun> {
  const { workflow, ticketKey, runId, adapters } = options;
  const runDir = join(repoDir, '.sail-runs', runId);
  mkdirSync(runDir, { recursive: true });
  const branch = `sail/${runId}`;
  const header = JSON.parse(readFileSync(join(GOLDEN_RUN, 'run.json'), 'utf8'));
  const live = {
    ...header,
    runId,
    workflow: { ...header.workflow, name: workflow },
    source: { ...header.source, ticketKey },
    branch,
  };
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(live, null, 2)}\n`);
  writeStatus(runDir, 'running');
  const { workspace } = adapters.ports;
  const { url } = await workspace.repository();
  const holder = { runId, runDir, pid: options.pid ?? process.pid };
  const leased = await workspace.lease(url, branch, holder);
  if (!leased.leased) throw new Error(`the live run's branch ${branch} is already leased`);
  return {
    runDir,
    branch,
    async suspend() {
      await workspace.lease(url, branch, { ...holder, suspended: true });
      writeStatus(runDir, 'suspended', 'interrupted');
    },
    async release() {
      await workspace.releaseLease(url, branch, runId);
    },
  };
}
