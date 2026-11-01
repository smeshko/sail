// `cleanRun()`: the engine side of `sail clean <run>`, which the dashboard can call in-process. It leaves nothing of a
// failed run behind but a copy of its run directory in sail's machine directory. In order:
// - **Checks, all before any removal:** the id names a run, whose STATUS is `failed`; no other run leases its branch,
//   nor does a run seeded from it lease its own;
//   no queue item names it, in any state; its branch has no open pull request, asked of the code host only when the
//   remote has the branch; and the archive destination is free. A check that can't be answered refuses the run.
// - **Removals, in order:** its worktree, local branch, remote branch and run ref. One already gone is skipped. One that
//   fails is reported and the rest still run. A run started from a pull request keeps both branches: they are the pull
//   request's head, which sail never made.
// - **Archive:** only when every removal succeeded, the run directory moves to
//   `<sail home>/failed-runs/<YYYY-MM-DD>/<run id>/`. A failed removal keeps it where it is, so a second clean reads its
//   header and finishes the job.
//
// It needs only the Workspace port, the queues through a lookup the caller hands in, so the engine reads no queue file
// itself, and the code host through a getter, so a run with no remote branch never needs the code host's credentials. It loads no workflow and writes into no run's event stream.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { CodeHost } from '../ports/code-host';
import { PortError } from '../ports/errors';
import type { WorkspacePort } from '../ports/workspace';
import { isPlainName } from './call-dir';
import { type Clock, systemClock } from './clock';
import { machineDir } from './machine-dir';
import { readOpening, readStatus, runsDir } from './run-dir';
import { RUN_HEADER_FILE, readRunHeader } from './run-header';

export interface CleanRunOptions {
  /** The `.sail/` the run belongs to: the run is found beside it. */
  sailDir: string;
  runId: string;
  workspace: WorkspacePort;
  /** The queue items of the repository that name run `runId`, or why the queues can't be read. */
  queueItems: (runId: string) => QueueNaming[] | { refused: string };
  /** The code host, asked for only when the run's branch is on the remote. */
  codeHost: () => Promise<CodeHost | { refused: string }>;
  /** Where `SAIL_HOME` is read from. This process's by default. */
  env?: Readonly<Record<string, string | undefined>>;
  /** What the archive's date is read from. The system's by default. */
  clock?: Clock;
}

/** A queue item that names a run, as the queue of `workflow` holds it. */
export interface QueueNaming {
  workflow: string;
  item: { dedupKey: string; state: string };
}

/** How a clean went: the run was cleaned and archived, a removal failed and the run directory stays, or it was refused. */
export type Cleaned =
  | { refused: string }
  | { cleaned: { runId: string; removed: string[]; archived: string } }
  | { failed: { runId: string; removed: string[]; failures: string[]; dir: string } };

const pad = (value: number): string => String(value).padStart(2, '0');

/** `<sail home>/failed-runs/<date>/<run id>`. */
export function archiveDir(env: Readonly<Record<string, string | undefined>>, date: Date, runId: string): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return join(machineDir(env), 'failed-runs', day, runId);
}

/**
 * The runs under `runs` seeded from run `runId`, whose branch is `<branch>-seeded-…`: by their header's `fromRun`, or,
 * for one still being opened, by the branch its `OPENING` names. Each comes with the branch and remote its lease is on.
 */
function seededFrom(runs: string, runId: string, branch: string): { runId: string; branch: string; remote: string }[] {
  const found: { runId: string; branch: string; remote: string }[] = [];
  for (const entry of readdirSync(runs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === runId || !isPlainName(entry.name)) continue;
    const dir = join(runs, entry.name);
    if (!existsSync(join(dir, RUN_HEADER_FILE))) {
      const opening = readOpening(dir);
      if (opening?.branch.startsWith(`${branch}-seeded-`)) found.push({ runId: entry.name, ...opening });
      continue;
    }
    try {
      const header = readRunHeader(dir);
      if (header.fromRun !== runId || header.branch === undefined || header.repository === undefined) continue;
      found.push({ runId: entry.name, branch: header.branch, remote: header.repository.url });
    } catch {
      // A header that can't be read names no run it was seeded from.
    }
  }
  return found.sort((a, b) => a.runId.localeCompare(b.runId));
}

/** Moves `from` to `to`, copying and removing across devices. */
function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true, force: true });
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function cleanRun(options: CleanRunOptions): Promise<Cleaned> {
  const { sailDir, runId, workspace } = options;
  const env = options.env ?? process.env;
  const runs = runsDir(sailDir);
  const root = dirname(sailDir);
  if (!isPlainName(runId)) return { refused: `'${runId}' is not a run id` };
  const dir = join(runs, runId);
  if (!existsSync(join(dir, RUN_HEADER_FILE))) return { refused: `no run '${runId}' in ${relative(root, runs)}` };

  const stopFirst = `stop it first: \`sail stop ${runId}\``;
  let status: ReturnType<typeof readStatus> | undefined;
  try {
    status = existsSync(join(dir, 'STATUS')) ? readStatus(dir) : undefined;
  } catch (error) {
    return { refused: messageOf(error) };
  }
  if (status === undefined) return { refused: `run ${runId} has no STATUS: ${stopFirst}` };
  if (status.status === 'running' || status.status === 'suspended') {
    return { refused: `run ${runId} is ${status.status}: ${stopFirst}` };
  }
  if (status.status === 'completed') return { refused: `run ${runId} completed: only a failed run is cleaned` };

  let header: ReturnType<typeof readRunHeader>;
  try {
    header = readRunHeader(dir);
  } catch (error) {
    return { refused: messageOf(error) };
  }
  const { branch, repository } = header;
  const run = { runId, runDir: dir };

  if (branch !== undefined && repository !== undefined) {
    try {
      const holder = await workspace.holder(repository.url, branch);
      if (holder !== undefined)
        return { refused: `run ${runId}: its branch ${branch} is leased by run ${holder.runId}` };
      for (const seeded of seededFrom(runs, runId, branch)) {
        const lease = await workspace.holder(seeded.remote, seeded.branch);
        if (lease?.runId === seeded.runId) {
          return { refused: `run ${runId}: run ${seeded.runId}, seeded from it, leases ${seeded.branch}` };
        }
      }
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      return { refused: `run ${runId}: the lease on ${branch} could not be read: ${error.message}` };
    }
  }

  const naming = options.queueItems(runId);
  if ('refused' in naming) return { refused: `run ${runId}: the queues could not be checked: ${naming.refused}` };
  const named = naming[0];
  if (named !== undefined) {
    return {
      refused: `queue item ${named.item.dedupKey} of ${named.workflow} (${named.item.state}) names run ${runId}: requeue it or drop it: \`sail queue requeue|drop\``,
    };
  }

  let present = { local: false, remote: false };
  if (branch !== undefined && repository !== undefined) {
    try {
      present = await workspace.branches(branch);
      if (present.remote) {
        const host = await options.codeHost();
        if ('refused' in host) {
          return { refused: `run ${runId}: the open pull requests of ${branch} could not be checked: ${host.refused}` };
        }
        const open = await host.pullRequestFrom(branch);
        if (open !== undefined) {
          return {
            refused: `run ${runId}: its branch ${branch} has an open pull request, #${open.number} (${open.url}): close it first`,
          };
        }
      }
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      return { refused: `run ${runId}: the branch ${branch} could not be checked: ${error.message}` };
    }
  }

  const date = (options.clock ?? systemClock)();
  const archived = archiveDir(env, date, runId);
  if (existsSync(archived)) return { refused: `run ${runId}: the archive ${archived} already exists` };

  const removed: string[] = [];
  const failures: string[] = [];
  const attempt = async (thing: string, removal: () => Promise<boolean>): Promise<void> => {
    try {
      if (await removal()) removed.push(thing);
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      failures.push(`the ${thing} was not removed: ${error.message}`);
    }
  };
  if (repository !== undefined) {
    const path = join(dir, header.workspace ?? 'workspace');
    if (existsSync(path)) {
      await attempt('worktree', async () => {
        await workspace.release(run, false);
        return true;
      });
    }
  }
  // A pull request's run works on the pull request's head, its author's branch and not sail's: it is never deleted.
  if (branch !== undefined && repository !== undefined) {
    if (header.source.kind !== 'pr') {
      await attempt(`branch ${branch}`, async () => (await workspace.removeBranch(branch, 'local')).removed);
      await attempt('remote branch', async () => (await workspace.removeBranch(branch, 'remote')).removed);
    }
    await attempt('run ref', async () => (await workspace.removeRunRef(runId)).removed);
  }

  if (failures.length === 0) {
    try {
      if (existsSync(archived)) throw new Error(`the archive ${archived} already exists`);
      move(dir, archived);
    } catch (error) {
      failures.push(`the run directory was not archived: ${messageOf(error)}`);
    }
  }
  if (failures.length > 0) return { failed: { runId, removed, failures, dir } };
  return { cleaned: { runId, removed, archived } };
}
