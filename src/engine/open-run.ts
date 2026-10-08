// Opens a run. `openRun()` opens a fresh one from a ticket: every check that can refuse comes first, and only then is
// `.sail-runs/<run id>/` created, holding the run header, an empty journal, an empty events file and STATUS `running`.
// `reopenRun()` opens an existing one to resume it: every check that can refuse comes first, and only then is its
// STATUS set back to `running`. So a refusal leaves no run directory behind, and a refused resume leaves the run as it
// was, down to the torn tail of its events file, which is cut only once no refusal remains. Both claim the `.sail/` for
// the process.
//
// A fresh run's checks, in order: the config, the workflow and its definitions, the model aliases, a stage named
// `intake`, an intake that accepts tickets and is a built-in, the stage `--until` names, then the ticket itself, which
// the ticket source must parse, hold, and show designated and unstarted unless `--force`. The claim comes last, since
// it is the one thing written before the run directory: the ticket moves to In Progress and gets a comment naming the
// run. The header is built and checked before it, so nothing but the ticket source can still refuse once the ticket
// has moved.
//
// One run per `.sail/` per process: Bun can't reload a module, so a second run would execute the definitions the first
// imported while its header hashes the files on disk. `sail <ticket>`, `sail resume` and the watcher's dispatch each
// start one run per process.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { createEventsFile, nextSeq } from '../events/consumers/ndjson';
import type { ProviderEvent } from '../events/types';
import type { PortAdapters } from '../ports/adapter';
import type { ProviderRelay, ResolvedAdapters } from './adapters';
import { isPlainName } from './call-dir';
import { DEFAULT_LABEL, PORTS, type Port, type ProjectConfig, readConfig } from './config';
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
import { claimSource, resolveSource } from './source';

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
  /**
   * What the claim did to the ticket, in order, for a fresh run's stream: the adapter's own events found no run
   * attached. Empty for a run with no ticket and for a reopened one.
   */
  claimed: readonly ProviderEvent[];
  /** The stage `--until` named, for a fresh run that was given one. A resume takes none. */
  until?: string;
  /** The `seq` the run's next event takes: 1 for a fresh run, where its events file stopped for a resumed one. */
  firstSeq: number;
}

export interface OpenRunOptions {
  /** Where the run starts from: `.sail/` is found from here up to the git root. */
  cwd: string;
  /** The workflow's name, its folder under `.sail/workflows/`. */
  workflow: string;
  /**
   * The ticket the run starts from, as typed: a ticket key, or a URL the ticket source owns. Its intake builds the
   * input. Left out, the run starts on the `LOCAL` stub.
   */
  ticket?: string;
  /** Runs a ticket that is not designated or not unstarted, and records which check it overrode. */
  force?: boolean;
  /** The stage after whose first call the run stops, suspended. One the workflow doesn't reach is refused. */
  until?: string;
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

/** Why `loaded` can't run when one of its stages took the intake's name, as a refusal: the two would share a key. */
function intakeNameTaken(loaded: LoadedWorkflow, sailDir: string): string | undefined {
  const taken = loaded.stages.find((stage) => stage.definition.name === INTAKE_STAGE);
  if (taken === undefined) return undefined;
  const file = relative(dirname(sailDir), join(taken.dir, 'stage.ts'));
  return `${file}: a stage can't be named '${INTAKE_STAGE}': its first call's key would be the intake's, ${INTAKE_KEY}`;
}

/** Why the workflow's intake can't take the ticket `ref`, as a refusal: it accepts no ticket, or isn't a built-in. */
function intakeProblem(loaded: LoadedWorkflow, sailDir: string, ref: string): string | undefined {
  const { name, accepts } = loaded.intake.definition;
  const file = relative(dirname(sailDir), join(loaded.dir, 'workflow.ts'));
  if (!accepts.includes('ticket')) {
    return `${file}: its intake '${name}' accepts ${accepts.join(', ') || 'nothing'}, and ${ref} is a ticket`;
  }
  if (intakeBody(loaded.intake) === undefined) {
    return `${file}: its intake '${name}' is the repository's own, and only a built-in intake runs`;
  }
  return undefined;
}

/**
 * Finds `.sail/`, reads its config, loads the workflow and checks the ticket, refusing at the first that fails, in the
 * order the header comment gives. It then mints the run id, builds the run header and checks it, and only then claims
 * the ticket: the one write before the run directory exists. A claim, a forced move or a comment that fails refuses
 * too, saying where the ticket stands. A header that breaks `sail.run.v1` throws: that is a bug in sail, not a
 * refusal. Last, it creates the run directory and writes the header, the journal and STATUS.
 *
 * With no ticket the run starts on the `LOCAL` stub: nothing is checked or claimed, and its input is the one given.
 *
 * A `.sail/` is claimed for the process once its config reads, before the workflow is imported, so even a refused load
 * claims it. Opening a second run from a claimed `.sail/` throws: that is a bug in the caller, never a refusal.
 */
export async function openRun(options: OpenRunOptions): Promise<OpenedRun | { refused: string }> {
  const { cwd, workflow, ticket, force = false, now = new Date() } = options;
  const found = findConfigured(cwd);
  if ('refused' in found) return found;
  const { config } = found;
  claim(found.dir);
  const loaded = await loadWorkflow(found.dir, workflow);
  if ('refused' in loaded) return loaded;
  const models = modelProblems(loaded, config);
  if (models.length > 0) return { refused: models.join('\n') };
  const taken = intakeNameTaken(loaded, found.dir);
  if (taken !== undefined) return { refused: taken };
  if (ticket !== undefined && options.input !== undefined) {
    return { refused: `a run from ticket ${ticket} gets its input from its intake, so it takes none` };
  }
  const unfit = ticket === undefined ? undefined : intakeProblem(loaded, found.dir, ticket);
  if (unfit !== undefined) return { refused: unfit };
  const { until } = options;
  const stages = loaded.stages.map((stage) => stage.definition.name);
  if (until !== undefined && !stages.includes(until)) {
    const known = stages.join(', ');
    return {
      refused: `--until names '${until}', which is no stage of workflow '${loaded.name}': its stages are ${known}`,
    };
  }
  const parsed = parseInput(loaded, options.input);
  if ('refused' in parsed) return parsed;
  const { input } = parsed;
  const fields = { sailDir: found.dir, loaded, config, adapters: options.adapters.entries, now };

  let runId: string;
  let header: RunHeader;
  let claimed: readonly ProviderEvent[] = [];
  if (ticket === undefined) {
    runId = newRunId(LOCAL_SOURCE.ticketKey, now.getTime());
    header = buildRunHeader({ runId, source: LOCAL_SOURCE, ...fields });
    assertRunHeader(header);
  } else {
    const { ticketSource } = options.adapters.ports;
    const resolved = await resolveSource({ ref: ticket, ticketSource, label: config.label ?? DEFAULT_LABEL, force });
    if ('refused' in resolved) return resolved;
    const { ticketKey } = resolved;
    runId = newRunId(ticketKey, now.getTime());
    // Built and checked before the ticket is touched, with the state as fetched standing in for the claim's answer.
    const source: Source = { kind: 'ticket', ticketKey, via: 'cli', forced: resolved.forced };
    const unclaimed = buildRunHeader({
      runId,
      source,
      claim: { claimed: false, state: resolved.ticket.state },
      ...fields,
    });
    assertRunHeader(unclaimed);
    const made = await claimSource({ ticketKey, runId, ticketSource, force });
    if ('refused' in made) return made;
    header = { ...unclaimed, source: { ...source, forced: [...resolved.forced, ...made.forced] }, claim: made.claim };
    assertRunHeader(header);
    claimed = made.events;
  }

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
    claimed,
    ...(until === undefined ? {} : { until }),
    firstSeq: 1,
  };
}

export interface ReopenRunOptions {
  /** Where the run is resumed from: `.sail/` is found from here up to the git root, and the run beside it. */
  cwd: string;
  /** The run's id, its directory under `.sail-runs/`. */
  runId: string;
  /** The input of a run with no ticket, given again and checked as on a fresh start. A run from a ticket takes none. */
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

/**
 * Reopens an existing run: every check that can refuse comes first, and only then is STATUS set back to `running`. The
 * workflow is loaded as it reads now, so a stage it has come to name `intake` is refused here as at a start.
 */
export async function reopenRun(options: ReopenRunOptions): Promise<OpenedRun | { refused: string }> {
  const { cwd, runId } = options;
  const found = findConfigured(cwd);
  if ('refused' in found) return found;
  const run = findRun(found.dir, runId);
  if ('refused' in run) return run;
  if (options.input !== undefined && !isLocalSource(run.header.source)) {
    return { refused: `run ${runId} got its input from ${INTAKE_KEY}, so --input doesn't apply` };
  }
  const changed = changedAdapters(run.header, options.adapters.entries);
  if (changed.length > 0) return { refused: `run ${runId} can't resume on different adapters:\n${changed.join('\n')}` };
  claim(found.dir);
  const loaded = await loadWorkflow(found.dir, run.header.workflow.name);
  if ('refused' in loaded) return loaded;
  const taken = intakeNameTaken(loaded, found.dir);
  if (taken !== undefined) return { refused: taken };
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
    claimed: [],
    firstSeq,
  };
}
