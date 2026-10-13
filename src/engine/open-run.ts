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
// has moved. A start aborted by then is refused too, with the ticket as it was: nothing exists to resume.
//
// One run per `.sail/` per process: Bun can't reload a module, so a second run would execute the definitions the first
// imported while its header hashes the files on disk. `sail <ticket>`, `sail resume` and the watcher's dispatch each
// start one run per process.
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createEventsFile, nextSeq } from '../events/consumers/ndjson';
import type { ProviderEvent } from '../events/types';
import type { PortAdapters } from '../ports/adapter';
import { PortError } from '../ports/errors';
import type { Workspace } from '../ports/types';
import type { WorkspacePort } from '../ports/workspace';
import type { ProviderRelay, ResolvedAdapters } from './adapters';
import { isPlainName } from './call-dir';
import { type Clock, systemClock } from './clock';
import { DEFAULT_LABEL, PORTS, type Port, type ProjectConfig, readConfig } from './config';
import { INTAKE_KEY, INTAKE_STAGE, intakeBody } from './intake';
import { createJournal } from './journal';
import { type LoadedWorkflow, loadWorkflow } from './load-workflow';
import { modelProblems } from './roster';
import { createRunDir, type RunStatus, readStatus, runsDir, type Source, writeStatus } from './run-dir';
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
  /** The absolute workspace the run's calls run in: its worktree, or the clone for a run that has none. */
  workspace: string;
  /** The branch lease the run holds, by the remote key it is kept under: released when the run ends unless it suspends. */
  lease: { remote: string; branch: string };
  /** The adapters the run was opened with, one per port. */
  adapters: PortAdapters;
  /** Where those adapters emit: the runtime attaches the run's stream to it. */
  relay: ProviderRelay;
  /** `project.yaml` as it reads now. What the run froze of it, such as each stage's model, is in `header`. */
  config: ProjectConfig;
  /** The workflow, with the stages it reaches: what the run replays. */
  loaded: LoadedWorkflow;
  /**
   * What the claim did to the ticket, in order, for a fresh run's stream: the adapter's own events found no run
   * attached. Empty for a reopened run.
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
  /** The ticket the run starts from, as typed: a ticket key, or a URL the ticket source owns. */
  ticket: string;
  /** Runs a ticket that is not designated or not unstarted, and records which check it overrode. */
  force?: boolean;
  /** The stage after whose first call the run stops, suspended. One the workflow doesn't reach is refused. */
  until?: string;
  /**
   * The run's clock: every time the run records is read from it. `openRun()` reads it once, on entry, for the run id's
   * time and the header's `startedAt`. The system's by default.
   */
  clock?: Clock;
  /** Fills the run id's random part. Random by default: a run that must be reproduced passes its bytes. */
  random?: (bytes: Uint8Array) => Uint8Array;
  /**
   * Refuses the start when it has aborted by the time the ticket would be claimed. Once the ticket is claimed the run
   * is opened whatever the signal says, and stopping it is its caller's.
   */
  signal?: AbortSignal;
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

/** The remote the workspace keys leases by for the clone at `root`, or the refusal when the clone can't name one. */
async function remoteKeyFor(workspace: WorkspacePort, root: string): Promise<{ remote: string } | { refused: string }> {
  try {
    return { remote: await workspace.remoteKey(root) };
  } catch (error) {
    if (error instanceof PortError && error.code === 'invalid') return { refused: error.message };
    throw error;
  }
}

/**
 * Takes the lease on `branch` for `holder`. A leased branch is a refusal naming the run that holds it, and `--force` does
 * not lift it (D3). A taken lease gives the event the run reports after its start.
 */
async function leaseBranch(
  workspace: WorkspacePort,
  remote: string,
  branch: string,
  holder: { runId: string; runDir: string; pid: number },
): Promise<{ events: ProviderEvent[] } | { refused: string }> {
  const result = await workspace.lease(remote, branch, holder);
  if (!result.leased) {
    return {
      refused: `${branch} is leased by run ${result.holder.runId}, which holds it until that run ends: a second run of the branch is refused, and --force does not lift that`,
    };
  }
  const took = result.took === undefined ? {} : { took: result.took };
  return { events: [{ type: 'workspace:leased', remote, branch, ...took }] };
}

/**
 * Finds `.sail/`, reads its config, loads the workflow and checks the ticket, refusing at the first that fails, in the
 * order the header comment gives. It then mints the run id, builds the run header and checks it, and only then claims
 * the ticket: the one write before the run directory exists. A start whose `signal` has aborted by then is refused
 * with the ticket untouched. A claim, a forced move or a comment that fails refuses too, saying where the ticket
 * stands. A header that breaks `sail.run.v1` throws: that is a bug in sail, not a refusal. Last, it creates the run
 * directory and writes the header, the journal and STATUS. A failure there throws too, and its message says where the
 * ticket stands: it has moved, and no run is behind it.
 *
 * A `.sail/` is claimed for the process once its config reads, before the workflow is imported, so even a refused load
 * claims it. Opening a second run from a claimed `.sail/` throws: that is a bug in the caller, never a refusal.
 */
export async function openRun(options: OpenRunOptions): Promise<OpenedRun | { refused: string }> {
  const { cwd, workflow, ticket, force = false } = options;
  // Read before anything can refuse, so the run id's time is the clock's first reading whatever else reads it later.
  const now = (options.clock ?? systemClock)();
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
  const unfit = intakeProblem(loaded, found.dir, ticket);
  if (unfit !== undefined) return { refused: unfit };
  const { until } = options;
  const stages = loaded.stages.map((stage) => stage.definition.name);
  if (until !== undefined && !stages.includes(until)) {
    const known = stages.join(', ');
    return {
      refused: `--until names '${until}', which is no stage of workflow '${loaded.name}': its stages are ${known}`,
    };
  }
  // The workspace names the remote its leases are keyed by before anything is claimed: a clone that can't name one is
  // refused here, with no run directory and no ticket move.
  const workspace = options.adapters.ports.workspace;
  const keyed = await remoteKeyFor(workspace, dirname(found.dir));
  if ('refused' in keyed) return keyed;
  const { ticketSource } = options.adapters.ports;
  const resolved = await resolveSource({ ref: ticket, ticketSource, label: config.label ?? DEFAULT_LABEL, force });
  if ('refused' in resolved) return resolved;
  const { ticketKey } = resolved;
  const runId = newRunId(ticketKey, now.getTime(), options.random);
  // Built and checked before the ticket is touched, with the state as fetched standing in for the claim's answer.
  const source: Source = { kind: 'ticket', ticketKey, via: 'cli', forced: resolved.forced };
  const unclaimed = buildRunHeader({
    runId,
    source,
    claim: { claimed: false, state: resolved.ticket.state },
    sailDir: found.dir,
    loaded,
    config,
    adapters: options.adapters.entries,
    now,
  });
  assertRunHeader(unclaimed);
  // The last moment the ticket is as it was. Everything up to here only read, so one check covers an abort at any of it.
  if (options.signal?.aborted) return { refused: 'stopped before the ticket was claimed' };
  // The branch is leased before the ticket is claimed, so a refused start leaves the ticket as it was (D2). The lease is
  // released on every refusal or throw before the run directory exists; once it does, the run holds it to its end.
  const branch = `sail/${ticketKey}`;
  const holder = { runId, runDir: join(runsDir(found.dir), runId), pid: process.pid };
  const leasing = await leaseBranch(workspace, keyed.remote, branch, holder);
  if ('refused' in leasing) return leasing;
  const releaseLease = () => workspace.releaseLease(keyed.remote, branch, runId);
  let made: Awaited<ReturnType<typeof claimSource>>;
  try {
    made = await claimSource({ ticketKey, runId, ticketSource, force });
  } catch (error) {
    await releaseLease();
    throw error;
  }
  if ('refused' in made) {
    await releaseLease();
    return made;
  }
  const forced = [...resolved.forced, ...made.forced];
  const header: RunHeader = { ...unclaimed, source: { ...source, forced }, claim: made.claim };
  // The ticket has moved, so whatever fails from here says where it stands. It is still thrown on, not refused: these
  // are sail's own files, or the workspace the ticket's branch was based on.
  const moved = (what: string, error: unknown): Error => {
    const why = error instanceof Error ? error.message : String(error);
    return new Error(
      `the ticket is now ${made.claim.state.name} and its comment names run ${runId}, but ${what}: ${why}. --force runs the ticket in a new run`,
      { cause: error },
    );
  };
  let dir: string;
  try {
    assertRunHeader(header);
    dir = createRunDir(found.dir, runId);
  } catch (error) {
    await releaseLease();
    throw moved('the run directory was not written', error);
  }
  // The run's worktree, made once its directory exists. Its events are captured here, since no run is attached yet, and
  // they go out after the claim's. A worktree that can't be made leaves no run directory and no lease behind.
  const captured: ProviderEvent[] = [];
  const detach = options.adapters.relay.attach((event) => {
    captured.push(event);
  });
  let worktree: Workspace;
  try {
    worktree = await workspace.create({ runId, runDir: dir }, { base: 'origin/HEAD', branch });
  } catch (error) {
    await releaseLease();
    rmSync(dir, { recursive: true, force: true });
    throw moved('its workspace was not made', error);
  } finally {
    detach();
  }
  // The header names the worktree relative to the clone, and the repository it came from when the workspace has one.
  const repository =
    worktree.defaultBranch === undefined
      ? {}
      : { repository: { url: keyed.remote, defaultBranch: worktree.defaultBranch, baseSha: worktree.baseSha } };
  const recorded: RunHeader = { ...header, workspace: relative(dirname(found.dir), worktree.path), ...repository };
  try {
    writeRunHeader(dir, recorded);
    createJournal(dir);
    createEventsFile(dir);
    writeStatus(dir, 'running');
  } catch (error) {
    await releaseLease();
    throw moved('the run directory was not written', error);
  }
  return {
    runId,
    dir,
    header: recorded,
    sailDir: found.dir,
    workspace: worktree.path,
    lease: { remote: keyed.remote, branch },
    adapters: options.adapters.ports,
    relay: options.adapters.relay,
    config,
    loaded,
    claimed: [...leasing.events, ...made.events, ...captured],
    ...(until === undefined ? {} : { until }),
    firstSeq: 1,
  };
}

export interface ReopenRunOptions {
  /** Where the run is resumed from: `.sail/` is found from here up to the git root, and the run beside it. */
  cwd: string;
  /** The run's id, its directory under `.sail-runs/`. */
  runId: string;
  /** The four adapters, resolved from the config before anything else. */
  adapters: ResolvedAdapters;
  /** The clock everything the resume records is read from. The system's by default. */
  clock?: Clock;
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

/**
 * The commit a worktree's HEAD names while it is detached, read from the `.git` file that points at its git directory:
 * `undefined` when it can't be read, or when HEAD names a branch.
 */
function headOfWorktree(path: string): string | undefined {
  try {
    const gitdir = readFileSync(join(path, '.git'), 'utf8')
      .trim()
      .replace(/^gitdir:\s*/, '');
    const head = readFileSync(join(resolve(path, gitdir), 'HEAD'), 'utf8').trim();
    return head.startsWith('ref:') ? undefined : head;
  } catch {
    return undefined;
  }
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
/** Whether `path` is a worktree of its own: a real directory whose `.git` is a file, the way git makes a worktree's. */
function isWorktreeOfItsOwn(path: string): boolean {
  try {
    return !lstatSync(path).isSymbolicLink() && lstatSync(join(path, '.git')).isFile();
  } catch {
    return false;
  }
}

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
  const taken = intakeNameTaken(loaded, found.dir);
  if (taken !== undefined) return { refused: taken };
  const workspace = options.adapters.ports.workspace;
  const keyed = await remoteKeyFor(workspace, dirname(found.dir));
  if ('refused' in keyed) return keyed;
  // A run resumes in its own worktree, which must still be there and still on the base the run started from. The header
  // names it, and a header that names another path (the clone, another run's worktree) is not trusted to say where it is.
  const recorded = run.header.workspace;
  // The header names the worktree relative to the clone, which is `dirname` of the sail directory.
  if (recorded !== undefined && resolve(dirname(found.dir), recorded) !== resolve(run.dir, 'workspace')) {
    return { refused: `run ${runId}'s workspace ${recorded} is not the run's own worktree: the run stays suspended` };
  }
  const worktree = recorded === undefined ? undefined : join(dirname(found.dir), recorded);
  if (worktree !== undefined && !existsSync(worktree)) {
    return { refused: `run ${runId}'s worktree ${recorded} is gone: the run stays suspended` };
  }
  if (worktree !== undefined && !isWorktreeOfItsOwn(worktree)) {
    return { refused: `run ${runId}'s workspace ${recorded} is a plain directory, not a worktree: the run stays suspended` };
  }
  const base = run.header.repository?.baseSha;
  if (worktree !== undefined && base !== undefined && !(await workspace.isBasedOn(worktree, base))) {
    const head = headOfWorktree(worktree) ?? 'a commit sail could not read';
    return {
      refused: `run ${runId}'s base ${base} is no ancestor of the HEAD of its worktree, ${head}: the run stays suspended`,
    };
  }
  // The lease is renewed under the run's own id and this process: another live run holding it refuses the resume.
  const branch = `sail/${run.header.source.ticketKey}`;
  const leasing = await leaseBranch(workspace, keyed.remote, branch, { runId, runDir: run.dir, pid: process.pid });
  if ('refused' in leasing) return leasing;
  // Last of the checks, since it cuts a torn tail: only a resume that goes ahead changes the file.
  const firstSeq = nextSeq(run.dir);
  if (typeof firstSeq !== 'number') return firstSeq;

  writeStatus(run.dir, 'running');
  return {
    runId,
    dir: run.dir,
    header: run.header,
    sailDir: found.dir,
    workspace: run.header.workspace === undefined ? dirname(found.dir) : join(dirname(found.dir), run.header.workspace),
    lease: { remote: keyed.remote, branch },
    adapters: options.adapters.ports,
    relay: options.adapters.relay,
    config: found.config,
    loaded,
    claimed: leasing.events,
    firstSeq,
  };
}
