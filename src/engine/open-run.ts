// Opens a fresh run: every check that can refuse comes first, and only then is `.sail-runs/<run id>/` created, holding
// the run header, an empty journal and STATUS `running`. So a refusal leaves nothing behind. Phase 3.2's runtime calls
// this to start a run; phase 3.3's resume opens an existing run directory with `readRunHeader()` instead.
//
// One run per `.sail/` per process: Bun can't reload a module, so a second run would execute the definitions the first
// imported while its header hashes the files on disk. `sail run`, `sail resume` and the watcher's dispatch each start
// one run per process.
import { realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { readConfig } from './config';
import { createJournal } from './journal';
import { type LoadedWorkflow, loadWorkflow } from './load-workflow';
import { createRunDir, LOCAL_SOURCE, type RunStatus, type Source, writeStatus } from './run-dir';
import { assertRunHeader, buildRunHeader, type RunHeader, writeRunHeader } from './run-header';
import { newRunId } from './run-id';
import { findSailDir } from './sail-dir';
import { formatIssue } from './schemas';

/** The realpaths of the `.sail/` directories a run has been opened from in this process. */
const claimed = new Set<string>();

export interface OpenedRun {
  runId: string;
  /** The absolute run directory. */
  dir: string;
  header: RunHeader;
  /** The absolute `.sail/` the run started from. */
  sailDir: string;
  /** The workflow, with the stages it reaches: what the run replays. */
  loaded: LoadedWorkflow;
  /** `run.input`: the input, parsed with the intake's schema, or undefined when none was given. */
  input: unknown;
}

export interface OpenRunOptions {
  /** Where the run starts from: `.sail/` is found from here up to the git root. */
  cwd: string;
  /** The workflow's name, its folder under `.sail/workflows/`. */
  workflow: string;
  /** What the run starts from. The `LOCAL` stub until intake exists. */
  source?: Source;
  /** The run id's time and the header's `startedAt`, from one clock. */
  now?: Date;
  /** The run's input, checked against the intake's schema. It stands in for what intake builds until intake exists. */
  input?: unknown;
}

/**
 * Finds `.sail/`, reads its config, loads the workflow and checks the input, refusing at the first that fails. It then
 * builds the run header and checks it, all before writing anything. A header that breaks `sail.run.v1` throws: that is a bug in sail,
 * not a refusal. Only then does it create the run directory and write the header, the journal and STATUS.
 *
 * A `.sail/` is claimed for the process once its config reads, before the workflow is imported, so even a refused load
 * claims it. Opening a second run from a claimed `.sail/` throws: that is a bug in the caller, never a refusal.
 */
export async function openRun(options: OpenRunOptions): Promise<OpenedRun | { refused: string }> {
  const { cwd, workflow, source = LOCAL_SOURCE, now = new Date() } = options;
  const found = findSailDir(cwd);
  if ('refused' in found) return found;
  const config = readConfig(found.dir);
  if ('issues' in config) {
    const file = relative(dirname(found.dir), join(found.dir, 'project.yaml'));
    return { refused: config.issues.map((issue) => formatIssue({ ...issue, file })).join('\n') };
  }
  const real = realpathSync(found.dir);
  if (claimed.has(real)) {
    throw new Error(
      `a run from ${found.dir} already started in this process: Bun can't reload its modules, so each run needs a process of its own`,
    );
  }
  claimed.add(real);
  const loaded = await loadWorkflow(found.dir, workflow);
  if ('refused' in loaded) return loaded;
  let input: unknown;
  if (options.input !== undefined) {
    const parsed = loaded.intake.definition.output.safeParse(options.input);
    if (!parsed.success) {
      const name = loaded.intake.definition.name;
      return { refused: `the input doesn't match intake '${name}':\n${z.prettifyError(parsed.error)}` };
    }
    input = parsed.data;
  }

  const runId = newRunId(source.ticketKey, now.getTime());
  const header = buildRunHeader({ runId, source, sailDir: found.dir, loaded, config, now });
  assertRunHeader(header);

  const dir = createRunDir(found.dir, runId);
  writeRunHeader(dir, header);
  createJournal(dir);
  writeStatus(dir, 'running');
  return { runId, dir, header, sailDir: found.dir, loaded, input };
}

export interface ReopenRunOptions {
  /** Where the run is resumed from: `.sail/` is found from here up to the git root, and the run beside it. */
  cwd: string;
  /** The run's id, its directory under `.sail-runs/`. */
  runId: string;
  /** The run's input, checked against the intake's schema as on a fresh start. */
  input?: unknown;
}

/**
 * Finds run `runId` beside `sailDir`, with its header and STATUS. A run that has completed or failed is refused, and so
 * is an id that isn't a plain name or names no run. A STATUS or `run.json` that can't be read throws.
 */
export function findRun(
  sailDir: string,
  runId: string,
): { dir: string; header: RunHeader; status: RunStatus } | { refused: string } {
  return { refused: `findRun is a stub: ${sailDir} ${runId}` };
}

/** Reopens an existing run: every check that can refuse comes first, and only then is STATUS set back to `running`. */
export async function reopenRun(options: ReopenRunOptions): Promise<OpenedRun | { refused: string }> {
  return { refused: `reopenRun is a stub: ${options.runId}` };
}
