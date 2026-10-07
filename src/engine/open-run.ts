// Opens a run. `openRun()` opens a fresh one: every check that can refuse comes first, and only then is
// `.sail-runs/<run id>/` created, holding the run header, an empty journal, an empty events file and STATUS `running`.
// `reopenRun()` opens an existing one to resume it: every check that can refuse comes first, and only then is its
// STATUS set back to `running`. So a refusal leaves nothing behind, apart from the torn tail of an events file, which
// is cut only once no refusal remains. Both claim the `.sail/` for the process.
//
// One run per `.sail/` per process: Bun can't reload a module, so a second run would execute the definitions the first
// imported while its header hashes the files on disk. `sail run`, `sail resume` and the watcher's dispatch each start
// one run per process.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { createEventsFile, nextSeq } from '../events/consumers/ndjson';
import type { PortAdapters } from '../ports/adapter';
import type { ProviderRelay, ResolvedAdapters } from './adapters';
import { isPlainName } from './call-dir';
import { PORTS, type Port, type ProjectConfig, readConfig } from './config';
import { INTAKE_KEY, INTAKE_STAGE, intakeBody } from './intake';
import { createJournal } from './journal';
import { type LoadedWorkflow, loadWorkflow } from './load-workflow';
import { modelProblems } from './roster';
import {
  createRunDir,
  isLocalSource,
  LOCAL_SOURCE,
  type RunStatus,
  readStatus,
  runsDir,
  type Source,
  writeStatus,
} from './run-dir';
import {
  type AdapterEntry,
  assertRunHeader,
  buildRunHeader,
  RUN_HEADER_FILE,
  type RunHeader,
  readRunHeader,
  writeRunHeader,
} from './run-header';
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
  /** The adapters the run was opened with, one per port. */
  adapters: PortAdapters;
  /** Where those adapters emit: the runtime attaches the run's stream to it. */
  relay: ProviderRelay;
  /** `project.yaml` as it reads now. What the run froze of it, such as each stage's model, is in `header`. */
  config: ProjectConfig;
  /** The workflow, with the stages it reaches: what the run replays. */
  loaded: LoadedWorkflow;
  /**
   * `run.input` of a run with no ticket: the input, parsed with the intake's schema, or undefined when none was given.
   * A run from a ticket has none here: its input is its journaled `intake#1`.
   */
  input: unknown;
  /** The `seq` the run's next event takes: 1 for a fresh run, where its events file stopped for a resumed one. */
  firstSeq: number;
}

export interface OpenRunOptions {
  /** Where the run starts from: `.sail/` is found from here up to the git root. */
  cwd: string;
  /** The workflow's name, its folder under `.sail/workflows/`. */
  workflow: string;
  /** What the run starts from: a ticket, whose intake builds the input, or the `LOCAL` stub when left out. */
  source?: Source;
  /** The run id's time and the header's `startedAt`, from one clock. */
  now?: Date;
  /** The input of a run with no ticket, checked against the intake's schema. Given beside a ticket, it is refused. */
  input?: unknown;
  /** The four adapters, resolved from the config before anything else. */
  adapters: ResolvedAdapters;
}

/** Claims `sailDir` for this process. A second claim throws: that is a bug in the caller, never a refusal. */
function claim(sailDir: string): void {
  const real = realpathSync(sailDir);
  if (claimed.has(real)) {
    throw new Error(
      `a run from ${sailDir} already started in this process: Bun can't reload its modules, so each run needs a process of its own`,
    );
  }
  claimed.add(real);
}

/** `run.input`: the input parsed with the intake's schema, undefined when none was given, or a refusal. */
function parseInput(loaded: LoadedWorkflow, input: unknown): { input: unknown } | { refused: string } {
  if (input === undefined) return { input: undefined };
  const parsed = loaded.intake.definition.output.safeParse(input);
  if (!parsed.success) {
    const name = loaded.intake.definition.name;
    return { refused: `the input doesn't match intake '${name}':\n${z.prettifyError(parsed.error)}` };
  }
  return { input: parsed.data };
}

/** Finds `.sail/` from `cwd` and reads its config, refusing on either. */
function findConfigured(cwd: string): { dir: string; config: ProjectConfig } | { refused: string } {
  const found = findSailDir(cwd);
  if ('refused' in found) return found;
  const config = readConfig(found.dir);
  if ('issues' in config) {
    const file = relative(dirname(found.dir), join(found.dir, 'project.yaml'));
    return { refused: config.issues.map((issue) => formatIssue({ ...issue, file })).join('\n') };
  }
  return { dir: found.dir, config };
}

/**
 * Finds `.sail/`, reads its config, loads the workflow and checks the input, refusing at the first that fails. It then
 * builds the run header and checks it, all before writing anything. A header that breaks `sail.run.v1` throws: that is a bug in sail,
 * not a refusal. Only then does it create the run directory and write the header, the journal and STATUS.
 *
 * A stage named `intake` is refused, whatever the run starts from. A run from a ticket is refused an input, since its
 * intake builds one, and a workflow whose intake is the repository's own, since only a built-in intake runs.
 *
 * A `.sail/` is claimed for the process once its config reads, before the workflow is imported, so even a refused load
 * claims it. Opening a second run from a claimed `.sail/` throws: that is a bug in the caller, never a refusal.
 */
export async function openRun(options: OpenRunOptions): Promise<OpenedRun | { refused: string }> {
  const { cwd, workflow, source = LOCAL_SOURCE, now = new Date() } = options;
  const found = findConfigured(cwd);
  if ('refused' in found) return found;
  const { config } = found;
  claim(found.dir);
  const loaded = await loadWorkflow(found.dir, workflow);
  if ('refused' in loaded) return loaded;
  const models = modelProblems(loaded, config);
  if (models.length > 0) return { refused: models.join('\n') };
  const at = (path: string) => relative(dirname(found.dir), path);
  const taken = loaded.stages.find((stage) => stage.definition.name === INTAKE_STAGE);
  if (taken !== undefined) {
    const why = `its first call's key would be the intake's, ${INTAKE_KEY}`;
    return { refused: `${at(join(taken.dir, 'stage.ts'))}: a stage can't be named '${INTAKE_STAGE}': ${why}` };
  }
  if (!isLocalSource(source)) {
    if (options.input !== undefined) {
      return { refused: `a run from ticket ${source.ticketKey} gets its input from its intake, so it takes none` };
    }
    if (intakeBody(loaded.intake) === undefined) {
      const name = loaded.intake.definition.name;
      const file = at(join(loaded.dir, 'workflow.ts'));
      return { refused: `${file}: its intake '${name}' is the repository's own, and only a built-in intake runs` };
    }
  }
  const parsed = parseInput(loaded, options.input);
  if ('refused' in parsed) return parsed;
  const { input } = parsed;

  const runId = newRunId(source.ticketKey, now.getTime());
  const header = buildRunHeader({
    runId,
    source,
    sailDir: found.dir,
    loaded,
    config,
    adapters: options.adapters.entries,
    now,
  });
  assertRunHeader(header);

  const dir = createRunDir(found.dir, runId);
  writeRunHeader(dir, header);
  createJournal(dir);
  createEventsFile(dir);
  writeStatus(dir, 'running');
  return {
    runId,
    dir,
    header,
    sailDir: found.dir,
    adapters: options.adapters.ports,
    relay: options.adapters.relay,
    config,
    loaded,
    input,
    firstSeq: 1,
  };
}

export interface ReopenRunOptions {
  /** Where the run is resumed from: `.sail/` is found from here up to the git root, and the run beside it. */
  cwd: string;
  /** The run's id, its directory under `.sail-runs/`. */
  runId: string;
  /** The input of a run with no ticket, given again and checked as on a fresh start. */
  input?: unknown;
  /** The four adapters, resolved from the config before anything else. */
  adapters: ResolvedAdapters;
}

/**
 * Finds run `runId` beside `sailDir`, with its header and STATUS. A run that has completed or failed is refused, and so
 * is an id that isn't a plain name or names no run. A STATUS or `run.json` that can't be read throws.
 */
export function findRun(
  sailDir: string,
  runId: string,
): { dir: string; header: RunHeader; status: RunStatus } | { refused: string } {
  if (!isPlainName(runId)) return { refused: `'${runId}' is not a run id` };
  const runs = runsDir(sailDir);
  const dir = join(runs, runId);
  if (!existsSync(join(dir, RUN_HEADER_FILE))) {
    return { refused: `no run '${runId}' in ${relative(dirname(sailDir), runs)}` };
  }
  const status = readStatus(dir);
  if (status.status === 'completed') return { refused: `run ${runId} has completed: there is nothing to resume` };
  if (status.status === 'failed') {
    return { refused: `run ${runId} failed (${status.stopReason}): a failed run is final` };
  }
  return { dir, header: readRunHeader(dir), status };
}

/** One line per port whose adapter, by `use` or `origin`, differs from the one the run started with. */
export function changedAdapters(header: RunHeader, entries: Record<Port, AdapterEntry>): string[] {
  const named = ({ use, origin }: AdapterEntry) => `${use} (${origin})`;
  return PORTS.filter((port) => {
    const was = header.adapters[port];
    return was.use !== entries[port].use || was.origin !== entries[port].origin;
  }).map(
    (port) =>
      `${port}: the run started with ${named(header.adapters[port])}, and .sail/project.yaml now names ${named(entries[port])}`,
  );
}

/** Reopens an existing run: every check that can refuse comes first, and only then is STATUS set back to `running`. */
export async function reopenRun(options: ReopenRunOptions): Promise<OpenedRun | { refused: string }> {
  const { cwd, runId } = options;
  const found = findConfigured(cwd);
  if ('refused' in found) return found;
  const run = findRun(found.dir, runId);
  if ('refused' in run) return run;
  const changed = changedAdapters(run.header, options.adapters.entries);
  if (changed.length > 0) return { refused: `run ${runId} can't resume on different adapters:\n${changed.join('\n')}` };
  claim(found.dir);
  const loaded = await loadWorkflow(found.dir, run.header.workflow.name);
  if ('refused' in loaded) return loaded;
  const parsed = parseInput(loaded, options.input);
  if ('refused' in parsed) return parsed;
  // Last of the checks, since it cuts a torn tail: only a resume that goes ahead changes the file.
  const firstSeq = nextSeq(run.dir);
  if (typeof firstSeq !== 'number') return firstSeq;

  writeStatus(run.dir, 'running');
  return {
    runId,
    dir: run.dir,
    header: run.header,
    sailDir: found.dir,
    adapters: options.adapters.ports,
    relay: options.adapters.relay,
    config: found.config,
    loaded,
    input: parsed.input,
    firstSeq,
  };
}
