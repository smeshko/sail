// Opens a run. `openRun()` opens a fresh one from a ticket: every check that can refuse comes first, then the run's
// branch is leased, and its run directory and workspace are made. Only then is `run.json` written, with the journal, the
// events file and STATUS `running`. Opening claims nothing: the ticket moves in `intake#1`, where the built-in `ticket`
// intake claims it and a repository intake claims only through `sail port ticket-source claim`. `reopenRun()` opens an existing one to resume it:
// every check that can refuse comes first, its lease renewed and its workspace reopened among them, and only then is its
// STATUS set back to `running`. So a refusal leaves no run directory, no workspace and no lease behind, and a refused
// resume leaves the run as it was, down to the torn tail of its events file, which is cut only once no refusal remains.
// Both claim the `.sail/` for the process.
//
// A fresh run's checks, in order: the config, the workflow and its definitions, the model aliases, a stage named
// `intake`, an intake that accepts tickets and is a built-in, the stage `--until` names, then the ticket itself, which
// the ticket source must parse, hold, and show designated and in a pick-up state unless `--force`. The run's header is built and
// checked before anything is written. Then, in order (D1):
//   1. the lease on the run's branch, which a live run holding it refuses, naming that run;
//   2. the run directory, then the workspace inside it;
//   3. a check that the start hasn't been aborted;
//   4. `run.json`, the journal, the events file and STATUS.
// A refusal at 2 or 3 undoes what came before it, in reverse: the workspace is released, the run directory removed and
// the lease released. A crash between the run directory and `run.json` leaves a directory with no header and a worktree
// no sweep removes; its lease goes stale with the pid. That window is an accepted risk.
//
// What the Workspace adapter emits from the lease to the abort check is kept, with each path made relative to the
// repository root, and the run's stream reports it after `run:start`, since no stream exists yet to hear it.
//
// A resume reads the branch and the base from `run.json`, never deriving them again (D8). It renews the lease with this
// process's pid, which a run that is still alive in another process refuses, and so does a lease another run has taken
// over. It then reopens the workspace, which must still be there and still descend from its base. A raise of the run's
// budget is checked with the refusals, right after the run is found: one of a budget the run doesn't have is refused,
// and so is a resume, raised or not, of a run still at or over its budget. A run from before workspaces existed has no
// workspace to resume in, and is refused.
//
// A dispatched start (`dispatch`) is the run the watcher started: it runs under the run id the watcher minted and named
// in its queue, and records `via: 'watch'`. It takes every step above in this order: the watcher only reads before it
// spawns the run, so everything a start can refuse still comes before anything is written. An id
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
import { createEventsFile, nextSeq, readEvents } from '../events/consumers/ndjson';
import type { Summary } from '../events/summary';
import type { ProviderEvent } from '../events/types';
import type { PortAdapters } from '../ports/adapter';
import { PortError } from '../ports/errors';
import type { Harness } from '../ports/harness';
import type { Repository, Workspace } from '../ports/types';
import type { RunRef, WorkspacePort } from '../ports/workspace';
import type { SourceKind } from '../sdk/intake';
import type { NamedHarnesses, ProviderRelay, ResolvedAdapters } from './adapters';
import { branchFor, DEFAULT_BRANCH_PREFIX } from './branch';
import { type Raise, raiseProblem } from './budget';
import { isPlainName } from './call-dir';
import { type Clock, systemClock } from './clock';
import { PORTS, type ProjectConfig, type RunPort, readConfig } from './config';
import { INTAKE_KEY, INTAKE_STAGE } from './intake';
import { createJournal, type JournalEntry } from './journal';
import { type LoadedWorkflow, loadWorkflow } from './load-workflow';
import { type ResolvedPullRequest, resolvePullRequest, resolveRef } from './pr-source';
import { credentialValues, type Redactor, redactor } from './redact';
import { harnessesReached, modelProblems } from './roster';
import {
  copyStageFolders,
  createRunDir,
  type RunStatus,
  readStatus,
  removeRunDir,
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
  workspaceFields,
  writeRunHeader,
} from './run-header';
import { isRunIdOf, newRunId } from './run-id';
import { findSailDir } from './sail-dir';
import { formatIssue } from './schemas';
import { type ResolvedSource, resolveSource } from './source';
import { watchLabel } from './watchable';

/** The realpaths of the `.sail/` directories a run has been opened from in this process. */
const claimed = new Set<string>();

export interface OpenedRun {
  redact: Redactor;
  runId: string;
  /** The absolute run directory. */
  dir: string;
  header: RunHeader;
  /** The absolute `.sail/` the run started from. */
  sailDir: string;
  /** The adapters the run was opened with, one per port. */
  adapters: Pick<PortAdapters, RunPort>;
  /** The named harnesses the run reached, by name. Empty when it reached none. */
  harnesses: Record<string, Harness>;
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
  /** The stage `--until` named, for a fresh run that was given one. A resume takes none. */
  until?: string;
  /** The `seq` the run's next event takes: 1 for a fresh run, where its events file stopped for a resumed one. */
  firstSeq: number;
  /**
   * A seeded run's reused calls, as its journal holds them, the run they were taken from, the stage it runs, and the
   * ticket the source's events name, when they do.
   */
  seeded?: {
    fromRun: string;
    stage: string;
    entries: readonly JournalEntry[];
    ticket?: Required<NonNullable<Summary['ticket']>>;
  };
  /** What a resume adds to the run's budget, recorded before anything runs. */
  raise?: Raise;
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
  secrets?: readonly string[];
  /** Where the run starts from: `.sail/` is found from here up to the git root. */
  cwd: string;
  /** The workflow's name, its folder under `.sail/workflows/`. */
  workflow: string;
  /** The ticket the run starts from, as typed: a ticket key, or a URL the ticket source owns. */
  ticket: string;
  /** Runs a ticket that is not designated or not in a pick-up state, and records which check it overrode. */
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
   * Refuses the start when it has aborted by the time its workspace exists. Once the run is opened it is opened
   * whatever the signal says, and stopping it is its caller's.
   */
  signal?: AbortSignal;
  /** The four adapters, resolved from the config before anything else. */
  adapters: ResolvedAdapters;
  /** A start the watcher dispatched: the run takes the id it minted, and its source is recorded `via: 'watch'`. */
  dispatch?: { runId: string };
  /**
   * The head sha a pull request must still be at: the one the watcher queued it at. A pull request whose head has moved
   * since is refused. Only a pull request takes it.
   */
  headSha?: string;
}

/** Claims `sailDir` for this process. A second claim throws: that is a bug in the caller, never a refusal. */
export function claim(sailDir: string): void {
  const real = realpathSync(sailDir);
  if (claimed.has(real)) {
    throw new Error(
      `a run from ${sailDir} already started in this process: Bun can't reload its modules, so each run needs a process of its own`,
    );
  }
  claimed.add(real);
}

/** Finds `.sail/` from `cwd` and reads its config, refusing on either. */
export function findConfigured(cwd: string): { dir: string; config: ProjectConfig } | { refused: string } {
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
export function intakeNameTaken(loaded: LoadedWorkflow, sailDir: string): string | undefined {
  const taken = loaded.stages.find((stage) => stage.definition.name === INTAKE_STAGE);
  if (taken === undefined) return undefined;
  const file = relative(dirname(sailDir), join(taken.dir, 'stage.ts'));
  return `${file}: a stage can't be named '${INTAKE_STAGE}': its first call's key would be the intake's, ${INTAKE_KEY}`;
}

/** Why the workflow's intake can't take `ref`, a source of `kind`, as a refusal: it accepts no source of that kind. */
function intakeProblem(loaded: LoadedWorkflow, sailDir: string, ref: string, kind: SourceKind): string | undefined {
  const { name, accepts } = loaded.intake.definition;
  const file = relative(dirname(sailDir), join(loaded.dir, 'workflow.ts'));
  if (!accepts.includes(kind)) {
    const is = kind === 'ticket' ? 'a ticket' : 'a pull request';
    return `${file}: its intake '${name}' accepts ${accepts.join(', ') || 'nothing'}, and ${ref} is ${is}`;
  }
  return undefined;
}

/**
 * Why a dispatch can't take `runId`: it isn't an id of a run of `ticketKey`, `pr-<number>` for a pull request, or that
 * run's directory exists.
 */
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
export function portRefusal(error: unknown): string {
  if (!(error instanceof PortError)) throw error;
  return `${error.message} (${error.code})`;
}

/**
 * Resolves the named harnesses `names` name through `adapters`, or refuses with each issue as a line of `project.yaml`'s.
 * A harness no name asks for is never loaded or asked for its credentials.
 */
export async function resolveNamed(
  adapters: ResolvedAdapters,
  sailDir: string,
  names: readonly string[],
): Promise<NamedHarnesses | { refused: string }> {
  if (names.length === 0) return { ports: {}, entries: {} };
  const named = await adapters.harnesses(names);
  if (!('issues' in named)) return named;
  const file = relative(dirname(sailDir), join(sailDir, 'project.yaml'));
  return { refused: named.issues.map((issue) => formatIssue({ ...issue, file })).join('\n') };
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
export function leasedBy(branch: string, holder: { runId: string; runDir: string }): string {
  return `the branch ${branch} is leased by run ${holder.runId} (${statusOf(holder.runDir)})`;
}

/**
 * Collects what the relay hears while `fn` runs: each `workspace:*` event, its path made relative to `root`. The relay
 * holds one sink at a time, so the collector is detached before this returns.
 */
export async function collecting<T>(
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

/**
 * Undoes an opened workspace whose run directory could not be written: releases the workspace, removes the run
 * directory and releases the lease, each as far as it still can be.
 */
export async function undoOpened(port: WorkspacePort, run: RunRef, remote: string, branch: string): Promise<void> {
  await quietly(() => port.release(run, false));
  await quietly(async () => removeRunDir(run.runDir));
  await quietly(() => port.releaseLease(remote, branch, run.runId));
}

/** What a fresh start made: the repository it leased a branch in, and the workspace. */
export interface Made {
  repository: Repository;
  workspace: Workspace;
}

/**
 * Leases `branch`, makes the run directory and the workspace at `base`, and checks for an abort, in that order. Left out,
 * `base` is the branch's tip on the remote when the remote has it, else the default branch's tip. A refusal at any step undoes the ones before it, in reverse.
 */
export async function startWorkspace(options: {
  port: WorkspacePort;
  run: RunRef;
  sailDir: string;
  branch: string;
  base?: string;
  signal: AbortSignal | undefined;
}): Promise<{ made: Made } | { refused: string }> {
  const { port, run, sailDir, branch, base, signal } = options;
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
    workspace = await port.create(run, {
      branch,
      ...(base === undefined ? {} : { base }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (!(error instanceof PortError)) {
      await undo('');
      throw error;
    }
    return undo(`the workspace could not be made: ${portRefusal(error)}`);
  }
  if (signal?.aborted) return undo('stopped before the run was opened');
  return { made: { repository, workspace } };
}

/** What a start's preflight found: everything `openRun()` goes on with once nothing has refused. */
export interface Preflight {
  sailDir: string;
  config: ProjectConfig;
  loaded: LoadedWorkflow;
  /** The ticket as fetched for the checks, with the checks `--force` overrode: a start from a ticket's. */
  resolved?: ResolvedSource;
  /** The pull request as fetched for the checks, with the checks `--force` overrode: a start from a pull request's. */
  pullRequest?: ResolvedPullRequest;
  source: Source;
  runId: string;
  branch: string;
  /** The header built before anything is written, with no workspace fields yet. */
  header: RunHeader;
  /** The named harnesses the workflow reaches, created. */
  harnesses: Record<string, Harness>;
}

/**
 * A start's preflight: every check that can refuse, in the order the header comment gives, then the run id, the branch
 * and the header, built and checked. It writes nothing, but it claims the `.sail/` for the process.
 */
export async function preflightRun(options: OpenRunOptions): Promise<Preflight | { refused: string }> {
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
  const named = await resolveNamed(options.adapters, found.dir, harnessesReached(loaded, config));
  if ('refused' in named) return named;
  const taken = intakeNameTaken(loaded, found.dir);
  if (taken !== undefined) return { refused: taken };
  const { ticketSource, codeHost } = options.adapters.ports;
  // Both adapters read the ref (D6). One neither reads is taken as a ticket's for an intake that takes no pull request,
  // so the ticket source's own refusal names it, as before pull requests were sources.
  const ref = resolveRef(ticket, ticketSource, codeHost);
  const neither = 'refused' in ref && ticketSource.parseKey(ticket) === undefined;
  if ('refused' in ref && !(neither && !loaded.intake.definition.accepts.includes('pr'))) return ref;
  const kind: SourceKind = 'refused' in ref ? 'ticket' : ref.kind;
  const unfit = intakeProblem(loaded, found.dir, ticket, kind);
  if (unfit !== undefined) return { refused: unfit };
  const { until } = options;
  const stages = loaded.stages.map((stage) => stage.definition.name);
  if (until !== undefined && !stages.includes(until)) {
    const known = stages.join(', ');
    return {
      refused: `--until names '${until}', which is no stage of workflow '${loaded.name}': its stages are ${known}`,
    };
  }
  const label = watchLabel(loaded.workflow, config);
  const branchPrefix = config.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  const via = dispatch === undefined ? 'cli' : 'watch';
  const headerOf = (runId: string, source: Source): RunHeader => {
    const header = buildRunHeader({
      runId,
      source,
      sailDir: found.dir,
      loaded,
      config,
      adapters: options.adapters.entries,
      harnesses: named.entries,
      now,
    });
    assertRunHeader(header);
    return header;
  };
  const runIdOf = (key: string): string | { refused: string } => {
    if (dispatch === undefined) return newRunId(key, now.getTime(), options.random);
    const refused = dispatchProblem(found.dir, key, dispatch.runId);
    return refused === undefined ? dispatch.runId : { refused };
  };

  if (!('refused' in ref) && ref.kind === 'pr') {
    let repository: Repository;
    try {
      repository = await options.adapters.ports.workspace.repository();
    } catch (error) {
      return { refused: `the workspace could not be read: ${portRefusal(error)}` };
    }
    const pullRequest = await resolvePullRequest({
      number: ref.number,
      codeHost,
      label,
      branchPrefix,
      defaultBranch: repository.defaultBranch,
      force,
      ...(options.headSha === undefined ? {} : { headSha: options.headSha }),
    });
    if ('refused' in pullRequest) return pullRequest;
    const runId = runIdOf(`pr-${ref.number}`);
    if (typeof runId !== 'string') return runId;
    const { pr } = pullRequest;
    const source: Source = { kind: 'pr', number: pr.number, headSha: pr.headSha, via, forced: pullRequest.forced };
    const header = headerOf(runId, source);
    const harnesses = named.ports;
    return { sailDir: found.dir, config, loaded, pullRequest, source, runId, branch: pr.head, header, harnesses };
  }

  if (options.headSha !== undefined) {
    return { refused: `--head-sha pins a pull request to its head, and ${ticket} is a ticket` };
  }
  const resolved = await resolveSource({
    ref: ticket,
    ticketSource,
    label,
    force,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (options.signal?.aborted) return { refused: 'stopped before the run was opened' };
  if ('refused' in resolved) return resolved;
  const { ticketKey } = resolved;
  const runId = runIdOf(ticketKey);
  if (typeof runId !== 'string') return runId;
  const branch = branchFor(branchPrefix, ticketKey, resolved.ticket.title);
  // Built and checked before anything is written. Opening a run claims nothing, so it has no claim.
  const source: Source = { kind: 'ticket', ticketKey, via, forced: resolved.forced };
  const header = headerOf(runId, source);
  return { sailDir: found.dir, config, loaded, resolved, source, runId, branch, header, harnesses: named.ports };
}

/**
 * Runs the start's preflight, `preflightRun()`, which finds `.sail/`, reads its config, loads the workflow and checks the
 * ticket, refusing at the first that fails, then mints the run id, names the branch, builds the run header and checks
 * it. A start whose `signal` has aborted by then is refused with nothing written. Then it leases the branch, makes the run
 * directory and the workspace, refusing and undoing what it made when either fails, or when the start aborts. The
 * ticket is not touched. A header that breaks `sail.run.v1` throws: that is a bug in sail, not a refusal. Last, it
 * writes the header, the journal and STATUS. A failure there throws too, after the workspace, the run directory and the
 * lease are undone, as far as they still can be.
 *
 * A `.sail/` is claimed for the process once its config reads, before the workflow is imported, so even a refused load
 * claims it. Opening a second run from a claimed `.sail/` throws: that is a bug in the caller, never a refusal.
 */
export async function openRun(options: OpenRunOptions): Promise<OpenedRun | { refused: string }> {
  const preflight = await preflightRun(options);
  if ('refused' in preflight) return preflight;
  const { config, loaded, source, runId, branch, header: preflighted, harnesses } = preflight;
  const found = { dir: preflight.sailDir };
  const { until } = options;
  // The last moment nothing is written. Everything up to here only read, so one check covers an abort at any of it.
  if (options.signal?.aborted) return { refused: 'stopped before the run was opened' };
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
      // A pull-request run starts at the head sha it was resolved at (D4).
      ...(source.kind === 'pr' ? { base: source.headSha } : {}),
    });
  });
  if ('refused' in opened) return opened;
  const { made } = opened;
  const redact = redactor(options.secrets ?? credentialValues(process.env));
  const header: RunHeader = redact.value({
    ...preflighted,
    ...workspaceFields({ branch, repository: made.repository, baseSha: made.workspace.baseSha }),
  });
  // A failure from here is thrown, not refused: these are sail's own files.
  const dir = run.runDir;
  try {
    assertRunHeader(header);
    copyStageFolders(dir, root, header);
    writeRunHeader(dir, header);
    createJournal(dir);
    createEventsFile(dir);
    writeStatus(dir, 'running');
  } catch (error) {
    // No run is behind the workspace, so nothing may hold its branch: undone as a refusal would, as far as it still can.
    await undoOpened(options.adapters.ports.workspace, run, made.repository.url, branch);
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`run ${runId}'s directory was not written: ${why}`, { cause: error });
  }
  return {
    runId,
    dir,
    header,
    redact,
    sailDir: found.dir,
    adapters: options.adapters.ports,
    harnesses,
    relay,
    config,
    loaded,
    workspace: { path: made.workspace.path, branch, baseSha: made.workspace.baseSha, remote: made.repository.url },
    started,
    ...(until === undefined ? {} : { until }),
    firstSeq: 1,
  };
}

export interface ReopenRunOptions {
  secrets?: readonly string[];
  /** Where the run is resumed from: `.sail/` is found from here up to the git root, and the run beside it. */
  cwd: string;
  /** The run's id, its directory under `.sail-runs/`. */
  runId: string;
  /** The four adapters, resolved from the config before anything else. */
  adapters: ResolvedAdapters;
  /** The clock everything the resume records is read from. The system's by default. */
  clock?: Clock;
  /** What to add to the run's budget: refused when the run has no such budget, or is still over it once added. */
  raise?: Raise;
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

/**
 * One line per port, then per named harness the run reached, whose adapter, by `use` or `origin`, differs from the one
 * the run started with. A named harness the config no longer defines has no entry in `harnesses`.
 */
export function changedAdapters(
  header: RunHeader,
  entries: Record<RunPort, AdapterEntry>,
  harnesses: Record<string, AdapterEntry> = {},
): string[] {
  const named = ({ use, origin }: AdapterEntry) => `${use} (${origin})`;
  const differs = (was: AdapterEntry, now: AdapterEntry) => was.use !== now.use || was.origin !== now.origin;
  const ports = PORTS.filter((port) => differs(header.adapters[port], entries[port])).map(
    (port) =>
      `${port}: the run started with ${named(header.adapters[port])}, and .sail/project.yaml now names ${named(entries[port])}`,
  );
  const reached = Object.entries(header.adapters.harnesses ?? {}).flatMap(([name, was]) => {
    const now = harnesses[name];
    if (now === undefined) {
      return [`harnesses.${name}: the run started with ${named(was)}, and .sail/project.yaml no longer defines it`];
    }
    if (!differs(was, now)) return [];
    return [`harnesses.${name}: the run started with ${named(was)}, and .sail/project.yaml now names ${named(now)}`];
  });
  return [...ports, ...reached];
}

/**
 * Renews the run's lease and reopens its workspace, or says why the run can't resume there: it predates workspaces, it
 * is still alive in another process, another run holds its branch, or its workspace is gone or has lost its base. A
 * refusal from `reopen()` keeps the run's lease, marked as held by no process.
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
      const lease = leased.file === undefined ? 'its lease' : `the lease file ${leased.file}`;
      return {
        refused: `run ${run.runId} is still running, in process ${holder.pid}: stop it before resuming it. If process ${holder.pid} is not sail, it took the pid of the run's ended process: remove ${lease}, then resume it`,
      };
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
    return refuseRenewedWorkspace(
      port,
      run,
      header,
      `run ${run.runId}'s workspace can't be reopened: ${portRefusal(error)}`,
    );
  }
}

/** A refused resume no longer has a process, but still owns its branch. */
async function refuseRenewedWorkspace(
  port: WorkspacePort,
  run: RunRef,
  header: RunHeader,
  refused: string,
): Promise<{ refused: string }> {
  const { branch, repository } = header;
  if (branch === undefined || repository === undefined) return { refused };
  try {
    const marked = await port.lease(repository.url, branch, {
      runId: run.runId,
      runDir: run.runDir,
      pid: process.pid,
      suspended: true,
    });
    if (!marked.leased)
      return { refused: `${refused}; its lease on ${branch} could not be marked as held by no process` };
  } catch (error) {
    return {
      refused: `${refused}; its lease on ${branch} could not be marked as held by no process: ${portRefusal(error)}`,
    };
  }
  return { refused };
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
  const budget = raiseProblem(runId, run.header.budget, readEvents(run.dir), options.raise);
  if (budget !== undefined) return { refused: budget };
  // The named harnesses the run reached, as its header froze them: one the config has dropped is changed, not resolved.
  const reached = Object.keys(run.header.adapters.harnesses ?? {});
  const defined = reached.filter((name) => Object.hasOwn(found.config.adapters.harnesses ?? {}, name));
  const named = await resolveNamed(options.adapters, found.dir, defined);
  if ('refused' in named) return named;
  const changed = changedAdapters(run.header, options.adapters.entries, named.entries);
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
  if (typeof firstSeq !== 'number') {
    return refuseRenewedWorkspace(
      options.adapters.ports.workspace,
      { runId, runDir: run.dir },
      run.header,
      firstSeq.refused,
    );
  }

  writeStatus(run.dir, 'running');
  return {
    runId,
    dir: run.dir,
    header: run.header,
    redact: redactor(options.secrets ?? credentialValues(process.env)),
    sailDir: found.dir,
    adapters: options.adapters.ports,
    harnesses: named.ports,
    relay,
    config: found.config,
    loaded,
    workspace,
    started,
    firstSeq,
    ...(options.raise === undefined ? {} : { raise: options.raise }),
  };
}
