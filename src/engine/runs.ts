// The runs in `.sail-runs/`: every one listed, and one found by its id or a prefix of it. A run is a directory holding
// `run.json`, so what `sail stage run` writes there is never one. Unlike resume's `findRun()`, nothing here refuses a
// run for how it ended: these are for viewing. `liveRuns()` is the exception: it names the runs of one workflow that are
// alive, which the cap on a workflow's concurrent runs counts.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspacePort } from '../ports/workspace';
import { isPlainName } from './call-dir';
import { RUNS_DIR, type RunStatus, readStatus, runsDir } from './run-dir';
import { RUN_HEADER_FILE, readRunHeader } from './run-header';

/** One run as `sail runs` lists it. A field whose file can't be read is left out, and `problem` says why. */
export interface RunListing {
  runId: string;
  dir: string;
  workflow?: string;
  startedAt?: string;
  status?: RunStatus;
  problem?: string;
}

/** How many of an ambiguous prefix's matches a refusal names. */
const SHOWN_MATCHES = 5;

/** The ids of the runs in `runs`, sorted. */
function runIds(runs: string): string[] {
  if (!existsSync(runs)) return [];
  return readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(runs, entry.name, RUN_HEADER_FILE)))
    .map((entry) => entry.name)
    .sort();
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Run `runId` as listed: its header's workflow and start, and its STATUS, each left out with its problem. */
function listing(runs: string, runId: string): RunListing {
  const dir = join(runs, runId);
  const listed: RunListing = { runId, dir };
  const problems: string[] = [];
  try {
    const header = readRunHeader(dir);
    listed.workflow = `${header.workflow.name}@${header.workflow.version}`;
    // sail.run.v1's timestamp pattern lets an impossible date like month 13 through, and it neither sorts nor prints.
    if (Number.isNaN(Date.parse(header.startedAt))) {
      problems.push(`${join(dir, RUN_HEADER_FILE)}'s startedAt '${header.startedAt}' is not a date`);
    } else {
      listed.startedAt = header.startedAt;
    }
  } catch (error) {
    problems.push(messageOf(error));
  }
  try {
    listed.status = readStatus(dir);
  } catch (error) {
    problems.push(messageOf(error));
  }
  if (problems.length > 0) listed.problem = problems.join('; ');
  return listed;
}

/** Oldest first, and a run with no start after every other. */
function byStart(a: RunListing, b: RunListing): number {
  if (a.startedAt === undefined || b.startedAt === undefined) {
    return Number(a.startedAt === undefined) - Number(b.startedAt === undefined);
  }
  return Date.parse(a.startedAt) - Date.parse(b.startedAt);
}

/**
 * Every run beside `sailDir`, oldest first, then by id. A run with no start goes last. A run `refuse` gives a reason
 * for is listed with that reason as its problem, and none of its files is read.
 */
export function listRuns(sailDir: string, refuse?: (dir: string) => string | undefined): RunListing[] {
  const runs = runsDir(sailDir);
  const listed = (runId: string): RunListing => {
    const dir = join(runs, runId);
    const problem = refuse?.(dir);
    return problem === undefined ? listing(runs, runId) : { runId, dir, problem };
  };
  // The ids come sorted, and the sort is stable, so runs that started together stay in id order.
  return runIds(runs).map(listed).sort(byStart);
}

/** The run `name` names: its exact id, or a prefix only one run's id starts with. */
export function resolveRun(sailDir: string, name: string): { runId: string; dir: string } | { refused: string } {
  if (!isPlainName(name)) return { refused: `'${name}' is not a run id` };
  const runs = runsDir(sailDir);
  if (existsSync(join(runs, name, RUN_HEADER_FILE))) return { runId: name, dir: join(runs, name) };
  const matches = runIds(runs).filter((runId) => runId.startsWith(name));
  const [only] = matches;
  if (only !== undefined && matches.length === 1) return { runId: only, dir: join(runs, only) };
  if (only === undefined) return { refused: `no run matching '${name}' in ${RUNS_DIR}` };
  const more = matches.length - SHOWN_MATCHES;
  const shown = `${matches.slice(0, SHOWN_MATCHES).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  return { refused: `'${name}' matches ${matches.length} runs: ${shown}` };
}

/**
 * The ids of the runs of `workflow` in `runs` that are alive now, sorted: STATUS `running`, and the lease on the run's
 * branch is its own, not suspended, and held by a pid that `isAlive` reads alive. A crashed run reads `running` forever,
 * so STATUS alone proves nothing. A run whose header can't be read, or that has no branch or repository, is skipped.
 * A `PortError` from reading a lease propagates.
 */
export async function liveRuns(
  runs: string,
  workflow: string,
  options: { workspace: Pick<WorkspacePort, 'holder'>; isAlive: (pid: number) => boolean },
): Promise<string[]> {
  const live: string[] = [];
  for (const runId of runIds(runs)) {
    const dir = join(runs, runId);
    try {
      if (readStatus(dir).status !== 'running') continue;
    } catch {
      continue;
    }
    let header: ReturnType<typeof readRunHeader>;
    try {
      header = readRunHeader(dir);
    } catch {
      continue;
    }
    if (header.workflow.name !== workflow || header.branch === undefined || header.repository === undefined) continue;
    const lease = await options.workspace.holder(header.repository.url, header.branch);
    if (lease?.runId === runId && !lease.suspended && options.isAlive(lease.pid)) live.push(runId);
  }
  return live;
}
