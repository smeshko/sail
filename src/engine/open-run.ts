// Opens a run. `openRun()` opens a fresh one from a ticket: every check that can refuse comes first, then the run's
// branch is leased, its run directory and workspace are made, and its ticket is claimed. Only then is `run.json`
// written, with the journal, the events file and STATUS `running`. `reopenRun()` opens an existing one to resume it:
// every check that can refuse comes first, its lease renewed and its workspace reopened among them, and only then is its
// STATUS set back to `running`. So a refusal leaves no run directory, no workspace and no lease behind, and a refused
// resume leaves the run as it was, down to the torn tail of its events file, which is cut only once no refusal remains.
// Both claim the `.sail/` for the process.
//
// A fresh run's checks, in order: the config, the workflow and its definitions, the model aliases, a stage named
// `intake`, an intake that accepts tickets and is a built-in, the stage `--until` names, then the ticket itself, which
// the ticket source must parse, hold, and show designated and unstarted unless `--force`. The run's header is built and
// checked before anything is written. Then, in order (D1):
//   1. the lease on the run's branch, which a live run holding it refuses, naming that run;
//   2. the run directory, then the workspace inside it;
//   3. a check that the start hasn't been aborted;
//   4. the claim: the ticket moves to In Progress and gets a comment naming the run;
//   5. `run.json`, the journal, the events file and STATUS.
// A refusal at 2 to 4 undoes what came before it, in reverse: the workspace is released, the run directory removed and
// the lease released. So a fetch that fails, or a claim lost to another start, costs no `--force`. A crash between the
// run directory and `run.json` leaves a directory with no header and a worktree no sweep removes; its lease goes stale
// with the pid. That window is an accepted risk.
//
// What the Workspace adapter emits from the lease to the claim is kept, with each path made relative to the repository
// root, and the run's stream reports it after `run:start`, since no stream exists yet to hear it.
//
// A resume reads the branch and the base from `run.json`, never deriving them again (D8). It renews the lease with this
// process's pid, which a run that is still alive in another process refuses, and so does a lease another run has taken
// over. It then reopens the workspace, which must still be there and still descend from its base. A run from before
// workspaces existed has no workspace to resume in, and is refused.
//
// A dispatched start (`dispatch`) is the run the watcher started: it runs under the run id the watcher minted and named
// in its queue, and records `via: 'watch'`. It takes every step above, the claim included, in this order: the watcher
// only reads before it spawns the run, so everything a start can refuse still comes before the ticket moves. An id
// that isn't one of this ticket's, or whose run directory exists, is refused. A forced queue item is dispatched with
// `force`, and records the checks it overrode as a forced manual run does.
//
// Every start checks designation against the workflow's label: its `watch.label`, then `project.yaml`'s, then sail's,
// the label its watcher polls.
//
// One run per `.sail/` per process: Bun can't reload a module, so a second run would execute the definitions the first
// imported while its header hashes the files on disk. `sail <ticket>`, `sail resume` and the watcher's dispatch each
// start one run per process.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createEventsFile, nextSeq } from '../events/consumers/ndjson';
import type { ProviderEvent } from '../events/types';
import type { PortAdapters } from '../ports/adapter';
import { PortError } from '../ports/errors';
import type { Repository, Workspace } from '../ports/types';
import type { RunRef, WorkspacePort } from '../ports/workspace';
import type { ProviderRelay, ResolvedAdapters } from './adapters';
import { branchFor, DEFAULT_BRANCH_PREFIX } from './branch';
import { isPlainName } from './call-dir';
import { type Clock, systemClock } from './clock';
import { PORTS, type Port, type ProjectConfig, readConfig } from './config';
import { INTAKE_KEY, INTAKE_STAGE, intakeBody } from './intake';
import { createJournal } from './journal';
import { type LoadedWorkflow, loadWorkflow } from './load-workflow';
import { modelProblems } from './roster';
import { createRunDir, type RunStatus, readStatus, removeRunDir, runsDir, type Source, writeStatus } from './run-dir';
import {
  type AdapterEntry,
  assertRunHeader,
  buildRunHeader,
  RUN_HEADER_FILE,
  type RunHeader,
  readRunHeader,
  workspaceFields,
  writeRunHeader,
} from './run-header';
import { isRunIdOf, newRunId } from './run-id';
import { findSailDir } from './sail-dir';
import { formatIssue } from './schemas';
import { type ClaimedSource, claimSource, resolveSource } from './source';
import { watchLabel } from './watchable';

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
  /** The run's workspace, its branch and base, and the remote its lease is keyed by. */
  workspace: OpenedWorkspace;
  /**
   * What the Workspace adapter reported while the run was being opened, in order, each path relative to the
   * repository root: the lease and the workspace for a fresh run, the renewed lease for a resume.
   */
  started: readonly ProviderEvent[];
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

/** Where a run works, and what holds it there. */
export interface OpenedWorkspace {
  /** The absolute path of the workspace. */
  path: string;
  branch: string;
  baseSha: string;
  /** The remote the run's lease is keyed by. */
  remote: string;
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
  /** A start the watcher dispatched: the run takes the id it minted, and its source is recorded `via: 'watch'`. */
  dispatch?: { runId: string };
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

/** Why a dispatch can't take `runId`: it isn't an id of a run of `ticketKey`, or that run's directory exists. */
function dispatchProblem(sailDir: string, ticketKey: string, runId: string): string | undefined {
  if (!isRunIdOf(ticketKey, runId)) {
    return `--dispatch takes the id of a new run of ${ticketKey}, ${ticketKey}-<26 Crockford characters>: '${runId}' is not one`;
  }
  const runs = runsDir(sailDir);
  if (existsSync(join(runs, runId))) {
    return `--dispatch names run ${runId}, which already exists in ${relative(dirname(sailDir), runs)}: a dispatch starts a new run`;
  }
  return undefined;
}

/** A port's failure as a refusal's words: its own message, with its code. Anything else is a bug, and is thrown on. */
function portRefusal(error: unknown): string {
  if (!(error instanceof PortError)) throw error;
  return `${error.message} (${error.code})`;
}

/** `event` with its `path`, which an adapter gives absolute, made relative to the repository `root`. */
export function rootRelative(event: ProviderEvent, root: string): ProviderEvent {
  if (!('path' in event) || typeof event.path !== 'string') return event;
  return { ...event, path: relative(root, event.path) || '.' };
}

/** The status of the run in `runDir`, for a refusal: `starting` while it has no STATUS yet. */
function statusOf(runDir: string): string {
  try {
    return readStatus(runDir).status;
  } catch {
    return 'starting';
  }
}

/** Why `branch` can't be leased: the run that holds it, and how that run stands. */
function leasedBy(branch: string, holder: { runId: string; runDir: string }): string {
  return `the branch ${branch} is leased by run ${holder.runId} (${statusOf(holder.runDir)})`;
}

/**
 * Collects what the relay hears while `fn` runs: each `workspace:*` event, its path made relative to `root`. The relay
 * holds one sink at a time, so the collector is detached before this returns.
 */
async function collecting<T>(
  relay: ProviderRelay,
  root: string,
  fn: (events: ProviderEvent[]) => Promise<T>,
): Promise<T> {
  const events: ProviderEvent[] = [];
  const detach = relay.attach((event) => {
    if (event.type.startsWith('workspace:')) events.push(rootRelative(event, root));
  });
  try {
    return await fn(events);
  } finally {
    detach();
  }
}

/** Runs one step of an undo, and lets its failure go: an undo does what it still can, and a sweep finds the rest. */
async function quietly(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch {
    // Left as it is: a worktree for a sweep, a lease that goes stale with this process.
  }
}

/** What a fresh start made before its claim, for the claim to build on, or to undo. */
interface Made {
  repository: Repository;
  workspace: Workspace;
}

/**
 * Leases `branch`, makes the run directory and the workspace, checks for an abort, and claims the ticket, in that
 * order. A refusal at any step undoes the ones before it, in reverse.
 */
async function startWorkspace(options: {
  port: WorkspacePort;
  run: RunRef;
  sailDir: string;
  branch: string;
  signal: AbortSignal | undefined;
  claim: () => Promise<ClaimedSource | { refused: string }>;
}): Promise<{ made: Made; claimed: ClaimedSource } | { refused: string }> {
  const { port, run, sailDir, branch, signal } = options;
  let repository: Repository;
  try {
    repository = await port.repository();
  } catch (error) {
    return { refused: `the workspace could not be made: ${portRefusal(error)}` };
  }
  let leased: Awaited<ReturnType<WorkspacePort['lease']>>;
  try {
    leased = await port.lease(repository.url, branch, { runId: run.runId, runDir: run.runDir, pid: process.pid });
  } catch (error) {
    return { refused: `the branch ${branch} could not be leased: ${portRefusal(error)}` };
  }
  if (!leased.leased) return { refused: leasedBy(branch, leased.holder) };

  let workspace: Workspace | undefined;
  const undo = async (refused: string): Promise<{ refused: string }> => {
    if (workspace !== undefined) await quietly(() => port.release(run, false));
    removeRunDir(run.runDir);
    await quietly(() => port.releaseLease(repository.url, branch, run.runId));
    return { refused };
  };
  try {
    createRunDir(sailDir, run.runId);
    workspace = await port.create(run, { branch, ...(signal === undefined ? {} : { signal }) });
  } catch (error) {
    if (!(error instanceof PortError)) {
      await undo('');
      throw error;
    }
    return undo(`the workspace could not be made: ${portRefusal(error)}`);
  }
  if (signal?.aborted) return undo('stopped before the ticket was claimed');
  const claimed = await options.claim();
  if ('refused' in claimed) return undo(claimed.refused);
  return { made: { repository, workspace }, claimed };
}

/**
 * Finds `.sail/`, reads its config, loads the workflow and checks the ticket, refusing at the first that fails, in the
 * order the header comment gives. It then mints the run id, names the branch, builds the run header and checks it. A
 * start whose `signal` has aborted by then is refused with nothing written. Then it leases the branch, makes the run
 * directory and the workspace, and claims the ticket, refusing and undoing what it made when any of them fails, or when
 * the start aborts before the claim. A claim, a forced move or a comment that fails refuses too, saying where the
 * ticket stands. A header that breaks `sail.run.v1` throws: that is a bug in sail, not a refusal. Last, it writes the
 * header, the journal and STATUS. A failure there throws too, and its message says where the ticket stands: it has
 * moved, and no run is behind it. So the workspace, the run directory and the lease are undone first, as far as they
 * still can be.
 *
 * A `.sail/` is claimed for the process once its config reads, before the workflow is imported, so even a refused load
 * claims it. Opening a second run from a claimed `.sail/` throws: that is a bug in the caller, never a refusal.
 */
export async function openRun(options: OpenRunOptions): Promise<OpenedRun | { refused: string }> {
  const { cwd, workflow, ticket, force = false, dispatch } = options;
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
  const { ticketSource } = options.adapters.ports;
  const label = watchLabel(loaded.workflow, config);
  const resolved = await resolveSource({ ref: ticket, ticketSource, label, force });
  if ('refused' in resolved) return resolved;
  const { ticketKey } = resolved;
  if (dispatch !== undefined) {
    const refused = dispatchProblem(found.dir, ticketKey, dispatch.runId);
    if (refused !== undefined) return { refused };
  }
  const runId = dispatch?.runId ?? newRunId(ticketKey, now.getTime(), options.random);
  const branch = branchFor(config.branchPrefix ?? DEFAULT_BRANCH_PREFIX, ticketKey, resolved.ticket.title);
  // Built and checked before anything is written, with the state as fetched standing in for the claim's answer.
  const source: Source = {
    kind: 'ticket',
    ticketKey,
    via: dispatch === undefined ? 'cli' : 'watch',
    forced: resolved.forced,
  };
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
  // The last moment nothing is written. Everything up to here only read, so one check covers an abort at any of it.
  if (options.signal?.aborted) return { refused: 'stopped before the ticket was claimed' };
  const root = dirname(found.dir);
  const run: RunRef = { runId, runDir: join(runsDir(found.dir), runId) };
  const { relay } = options.adapters;
  let started: ProviderEvent[] = [];
  const opened = await collecting(relay, root, async (events) => {
    started = events;
    return startWorkspace({
      port: options.adapters.ports.workspace,
      run,
      sailDir: found.dir,
      branch,
      signal: options.signal,
      claim: () => claimSource({ ticketKey, runId, ticketSource, force }),
    });
  });
  if ('refused' in opened) return opened;
  const { made, claimed: took } = opened;
  const forced = [...resolved.forced, ...took.forced];
  const header: RunHeader = {
    ...unclaimed,
    source: { ...source, forced },
    claim: took.claim,
    ...workspaceFields({ branch, repository: made.repository, baseSha: made.workspace.baseSha }),
  };
  // The ticket has moved, so whatever fails from here says where it stands. It is still thrown on, not refused: these
  // are sail's own files.
  const dir = run.runDir;
  try {
    assertRunHeader(header);
    writeRunHeader(dir, header);
    createJournal(dir);
    createEventsFile(dir);
    writeStatus(dir, 'running');
  } catch (error) {
    // No run is behind the claim, so nothing may hold its branch: undone as a refusal would, as far as it still can.
    const { workspace: port } = options.adapters.ports;
    await quietly(() => port.release(run, false));
    await quietly(async () => removeRunDir(dir));
    await quietly(() => port.releaseLease(made.repository.url, branch, runId));
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the ticket is now ${took.claim.state.name} and its comment names run ${runId}, but the run directory was not written: ${why}. --force runs the ticket in a new run`,
      { cause: error },
    );
  }
  return {
    runId,
    dir,
    header,
    sailDir: found.dir,
    adapters: options.adapters.ports,
    relay,
    config,
    loaded,
    workspace: { path: made.workspace.path, branch, baseSha: made.workspace.baseSha, remote: made.repository.url },
    started,
    claimed: took.events,
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
  const ended = endedRefusal(runId, status);
  if (ended !== undefined) return { refused: ended };
  return { dir, header: readRunHeader(dir), status };
}

/** Why run `runId` can't be resumed because it has ended, or undefined while it hasn't. */
function endedRefusal(runId: string, status: RunStatus): string | undefined {
  if (status.status === 'completed') return `run ${runId} has completed: there is nothing to resume`;
  if (status.status === 'failed') return `run ${runId} failed (${status.stopReason}): a failed run is final`;
  return undefined;
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
 * Renews the run's lease and reopens its workspace, or says why the run can't resume there: it predates workspaces, it
 * is still alive in another process, another run holds its branch, or its workspace is gone or has lost its base. A
 * refusal from `reopen()` leaves the lease renewed, since the run still owns it.
 */
async function resumeWorkspace(
  port: WorkspacePort,
  run: RunRef,
  header: RunHeader,
): Promise<OpenedWorkspace | { refused: string }> {
  const { branch, repository } = header;
  if (branch === undefined || repository === undefined) {
    return { refused: `run ${run.runId} started before runs had workspaces: it has no workspace to resume in` };
  }
  let leased: Awaited<ReturnType<WorkspacePort['lease']>>;
  try {
    leased = await port.lease(repository.url, branch, { runId: run.runId, runDir: run.runDir, pid: process.pid });
  } catch (error) {
    return { refused: `the branch ${branch} could not be leased: ${portRefusal(error)}` };
  }
  if (!leased.leased) {
    const { holder } = leased;
    if (holder.runId === run.runId) {
      return { refused: `run ${run.runId} is still running, in process ${holder.pid}: stop it before resuming it` };
    }
    return { refused: leasedBy(branch, holder) };
  }
  // A run that ended while this resume loaded its workflow, as a `sail stop` ends one, stays ended: the lease goes back.
  const ended = endedRefusal(run.runId, readStatus(run.runDir));
  if (ended !== undefined) {
    try {
      await port.releaseLease(repository.url, branch, run.runId);
    } catch (error) {
      return { refused: `${ended}, and its lease on ${branch} was not released: ${portRefusal(error)}` };
    }
    return { refused: ended };
  }
  try {
    const reopened = await port.reopen(run, { branch, baseSha: repository.baseSha });
    return { path: reopened.path, branch, baseSha: repository.baseSha, remote: repository.url };
  } catch (error) {
    return { refused: `run ${run.runId}'s workspace can't be reopened: ${portRefusal(error)}` };
  }
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
  const changed = changedAdapters(run.header, options.adapters.entries);
  if (changed.length > 0) return { refused: `run ${runId} can't resume on different adapters:\n${changed.join('\n')}` };
  claim(found.dir);
  const loaded = await loadWorkflow(found.dir, run.header.workflow.name);
  if ('refused' in loaded) return loaded;
  const taken = intakeNameTaken(loaded, found.dir);
  if (taken !== undefined) return { refused: taken };
  const { relay } = options.adapters;
  let started: ProviderEvent[] = [];
  const workspace = await collecting(relay, dirname(found.dir), (events) => {
    started = events;
    return resumeWorkspace(options.adapters.ports.workspace, { runId, runDir: run.dir }, run.header);
  });
  if ('refused' in workspace) return workspace;
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
    relay,
    config: found.config,
    loaded,
    workspace,
    started,
    claimed: [],
    firstSeq,
  };
}
