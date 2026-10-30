// Runs a workflow to its end: open the run, then loop. Each turn replays the workflow against the journal, runs the call
// the replay stopped at, and journals it, until a replay ends the run and STATUS records how. Start, continue and resume
// are this one loop: a resume enters it with an existing run directory. Every step runs in the run's workspace, while
// `.sail/` and everything a run records stay the repository's: paths are recorded relative to the directory that holds
// `.sail/`.
//
// A run runs its intake before the first replay and journals it as `intake#1`, the journal's first line.
// Every replay is handed that entry beside the stage entries, so a resume reads the input from the journal and never
// fetches the ticket again. An intake that didn't pass fails the run with `stage_error`: no workflow code has run, and
// nothing can route on it. An intake of the repository's own runs its steps as that one call, from the run's source,
// and only the call's line is journaled: its steps' results are in the call directory, and a call interrupted before
// it ended runs again from its first step.
//
// A group, `run.all()`, ends the replay with its unjournaled calls, which run at once, each in its own call directory.
// Each is journaled as it completes, carrying the group's keys, so the journal holds them in completion order, and
// `all:start` and `all:end` bracket them. An `error` doesn't stop its siblings. A call that throws, a bug in sail, stops
// them, and the error goes on once they have settled, even when reporting `all:end` fails too. An abort suspends the
// run with the calls that completed journaled. The relay's key is the running call's while exactly one runs, and none
// otherwise.
//
// What the adapters emit while the run is going reaches its stream through the relay, stamped with the key of the call
// that is running. A workspace event carries none, and its path is made relative to the repository root. The lease and
// the workspace are made before the run directory holds anything, so a fresh run reports them from what opening it
// collected, right after `run:start` and with no key: `workspace:leased` and `workspace:created`. Opening claims
// nothing: the built-in `ticket` intake's claim reaches the stream through the relay under `intake#1`, as
// `ticket:claimed`, or `ticket:updated` for a forced move, then `ticket:commented`. A resume reports its renewed lease
// first, and none of the rest again.
//
// A gitDiff binding is resolved just before its call, through the Workspace port's `diff()` on the run's workspace, and
// handed to the call as a patch. A diff that fails fails the run with `workflow_failed`, before the call is written.
//
// A run that completes or fails releases its workspace, then its lease, once STATUS says how it ended and before
// `run:end`. A workspace that can't be removed doesn't keep the lease: it is left for a sweep, and `run:end` says so. A
// lease that can't be released doesn't keep `run:end` from the stream either, which says so too. A suspended run keeps
// both, and so does a crashed one, whose lease goes stale with its pid.
//
// A request from outside the run's process comes through its control file (`control.ts`), taken before the intake and
// before each call, right after the abort check: `unwatched` suspends the run with that stop reason, keeping its
// workspace and lease, and `stopped` fails it with that stop reason, releasing both. An abort seen at the same boundary
// goes first, and leaves the request for the next boundary that runs. A request goes ahead of `until`'s suspension.
//
// A multi-step call journals each step as it finishes, as `stage#call/step`, then the call itself once its last step
// has run or one has stopped it. The replay is handed the call lines only, so it goes by position over calls as it
// always has. A resume hands a call its step lines, and the call runs only the steps after them, or none when every
// step is journaled and only the call line is missing. A call's step lines must be its stage's first steps in order,
// and every step line must belong to a call the journal holds or the workflow asks for now: anything else fails the
// run with `determinism_violation`, before anything runs.
//
// A run with a budget is driven under its tracker (`budget.ts`). Each agent request is handed the run's share of what it
// has left, and the harness ends a session that reaches it. A call that ran out of the run's budget, an `error` with
// `budget_exceeded` whose request the run's budget narrowed, is left unjournaled, so the next replay asks for it again.
// So is a step of a multi-step call, with its call. The budget is checked before the intake and before each call, after
// the abort and the control file: a run that has used it up is suspended with `budget_exceeded`, `run:suspended` then
// STATUS then `run:end`, keeping its workspace and lease. Within a multi-step call it is checked again after each step
// that passed with another to follow: once used up, the call stops there unjournaled, and the check before it suspends
// the run. Each replay also races the remaining minutes, suspending even when workflow code awaits forever between
// calls. A resume given a raise records it as `budget:raised` before anything runs.
//
// An abort stops the running call and suspends the run with `interrupted`. The interrupted call is left unjournaled, so
// a resume runs it again as its next try. An abort also stops a replay that hangs in the workflow's own code, since
// Ctrl-C no longer directly ends the process once sail listens for it. One seen while a fresh run is being opened, before its
// workspace is made, refuses the start instead: nothing was written, so there is no run to suspend.
//
// A call (or a step of one) that hit the provider's usage limit suspends the run with `usage_limit`, `run:suspended`
// naming the call and the reset time when the provider gave one. The call is left unjournaled, like an interrupted one,
// and the workspace and lease are kept; in a group the members that passed are journaled first.
//
// A seeded run is driven by this same loop: its journal already holds the reused calls, so the intake isn't run again
// and the replay returns each reused call from its line. Its `run:start` carries `fromRun`, and each reused call is
// reported once, right after what opening the run did, as a `journal:append` with `fromRun`; the intake's also carries
// the source's ticket, which names the run's ticket in its summary as no fetch happened. Unless `--continue`, it
// stops after the stage it was seeded for, as `until` stops a run. A seed never splits a group: when the stage's first
// call belongs to one, the seeded run's first move is the whole group.
//
// `until` names a stage to stop after. Once that stage's first call is journaled the next replay still runs: if it
// ends the run, the run ends that way, and if it asks for another call the run is suspended with `until` instead, where
// an abort seen before a call suspends it. A resume takes none and runs to the end.
//
// A run holds a keep-awake (`keep-awake.ts`) from before it opens until it has ended, whatever the end: completed,
// failed, suspended, refused or an exception, through `awake()` in each of the three exports. Each reports its hold once
// as `run:keep_awake`, after what opening the run did and before the intake: a resume's comes after its renewed lease, so
// the budget's segment still starts there.
//
// An exception inside sail, such as a journal that can't be trusted or a bug in a call, propagates and leaves STATUS
// `running`: writing it may be what failed, and a `running` run with no process is how a dead one looks.
//
// Every event of the run goes through one bus to `events.ndjson`, then to `summary.json`, which is rewritten after every
// call, and then to any consumers passed in. The runtime emits
// `run:start` for a fresh run, `journal:append` for each call it journals, `run:end` once STATUS says how the run
// ended, and `error:crash` before an exception inside sail propagates. The call emits its own events, and the replay
// the loop and route events of the moves past the journal's end. A resume continues the file's `seq` with no marker.
// `run:end` ends the stream: a replay abandoned by an interrupt or budget may move on once its workflow stops waiting,
// but nothing it reports after that is emitted. The bin exits once the command returns, ending any leftover handles.
import { dirname, join, relative } from 'node:path';
import { createBus } from '../events/bus';
import { ndjsonConsumer, readEvents } from '../events/consumers/ndjson';
import { summaryConsumer } from '../events/consumers/summary';
import type { Consumer, Emit, NewEvent, ProviderEvent, SailEvent } from '../events/types';
import { PortError } from '../ports/errors';
import type { Harness } from '../ports/harness';
import type { StageDefinition } from '../sdk/steps';
import type { Supplied } from './bindings';
import { DEFAULT_BRANCH_PREFIX } from './branch';
import { type BudgetTracker, recordIn, suspension, trackBudget } from './budget';
import { type AgentExecution, asStep, callProblems, type Ran, runCall } from './call';
import { type CallPaths, nextTry, runRelative } from './call-dir';
import { type Clock, systemClock } from './clock';
import { stopNowRequested, takeControl } from './control';
import {
  INTAKE_INDEX,
  INTAKE_KEY,
  INTAKE_STAGE,
  intakeBody,
  intakeEmit,
  intakeFailure,
  ownIntakeStage,
  runIntake,
} from './intake';
import {
  appendJournal,
  JOURNAL_FILE,
  type JournalEntry,
  JournalError,
  type NewJournalEntry,
  readJournal,
} from './journal';
import { type KeepAwake, type KeepAwakeHold, systemKeepAwake } from './keep-awake';
import type { LoadedIntake } from './load-workflow';
import {
  type OpenedRun,
  type OpenRunOptions,
  openRun,
  type ReopenRunOptions,
  reopenRun,
  rootRelative,
} from './open-run';
import { type PendingCall, type ReplayEnd, replay } from './replay';
import type { RosterEntry } from './roster';
import { copiedIntakeFile, copiedStageFile, type StopReason, writeStatus } from './run-dir';
import { openSeededRun, type SeededRunOptions } from './seed-run';

/** Who else receives a run's events, beside `events.ndjson`. */
interface EventOptions {
  /** Consumers that receive every event after the events file and the summary. */
  consumers?: readonly Consumer[];
  /** Where a consumer's throw on an `error:consumer` event goes. Stderr by default. */
  unreported?: (error: unknown, consumer: Consumer, event: SailEvent) => void;
  /** What holds the machine awake while the run's process drives it. The system's by default. */
  keepAwake?: KeepAwake;
}

/** How a run ended. */
export interface RunEnd {
  runId: string;
  dir: string;
  status: 'completed' | 'failed' | 'suspended';
  stopReason?: StopReason;
  /** Why a failed or suspended run stopped, for people. */
  message?: string;
  /** What the workflow returned, when it completed. */
  result?: unknown;
  /** The budget a run suspended with `budget_exceeded` used up. */
  budget?: 'usd' | 'minutes';
  /** When the usage limit a run suspended with `usage_limit` hit resets, when the provider said. */
  resetsAt?: string;
}

/** A call that hit the provider's usage limit. */
interface Limited {
  key: string;
  resetsAt?: string;
}

export interface RunWorkflowOptions extends OpenRunOptions, EventOptions {
  /**
   * Stops the running call when it aborts, and suspends the run. Aborted before the run is opened, it refuses the
   * start.
   */
  signal?: AbortSignal;
  /** Called after each call is journaled. */
  onCall?(entry: JournalEntry): void;
}

export interface SeededWorkflowOptions extends SeededRunOptions, EventOptions {
  /** Stops the running call when it aborts, and suspends the run. Aborted before the run opens, it refuses it. */
  signal?: AbortSignal;
  /** Called after each call is journaled. */
  onCall?(entry: JournalEntry): void;
  /**
   * Called once the run is open and its start and reused calls are in its events file, before any call runs: what a
   * refusal to open must not do waits for it.
   */
  onOpened?(): Promise<void>;
}

export interface ResumeWorkflowOptions extends ReopenRunOptions, EventOptions {
  /** Stops the running call when it aborts, and suspends the run again. */
  signal?: AbortSignal;
  /** Called after each call is journaled. */
  onCall?(entry: JournalEntry): void;
}

/** What drives an opened run, whether it started or resumed. */
interface DriveOptions extends EventOptions {
  /** The run's clock: each event's `ts`, each try's times and each journal line's `recordedAt` is a reading of it. */
  clock?: Clock;
  signal?: AbortSignal;
  onCall?(entry: JournalEntry): void;
  /** Called once the run's start, and a seeded run's reused calls, are in its events file. */
  onOpened?(): Promise<void>;
}

/** Why a call ended as it did, for the workflow: an error's problems, each with its reason, or a blocked agent's own. */
function reasonOf(result: Record<string, unknown>): string | null {
  if (result.outcome === 'blocked') return String(result.reason);
  if (result.outcome !== 'error') return null;
  const errors = (result.errors ?? []) as { reason: string; message: string }[];
  return errors.map(({ reason, message }) => `${reason}: ${message}`).join('; ');
}

/** The journal entry of a call or a step that ran, from its `result.json`. */
function entryFrom(
  runDir: string,
  result: Record<string, unknown>,
  paths: CallPaths,
  group?: string[],
): NewJournalEntry {
  const files = result.files as Record<string, { path: string }>;
  return {
    key: result.key as string,
    stage: result.stage as string,
    call: result.call as number,
    ...(typeof result.step === 'string' ? { step: result.step } : {}),
    outcome: result.outcome as JournalEntry['outcome'],
    output: result.output,
    reason: reasonOf(result),
    files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.path])),
    resultPath: runRelative(runDir, paths.result),
    ...(group === undefined ? {} : { group }),
  };
}

/**
 * What an agent call runs on: the run's harness, or the named harness its roster entry names, the conventions `project.yaml` lists now, and the model the run's
 * roster froze at its start, which a resume keeps whatever the alias names by then.
 */
function executionOf(
  opened: OpenedRun,
  stage: string,
  entry: RosterEntry | undefined,
  tracker: BudgetTracker | undefined,
): AgentExecution {
  const { conventions } = opened.config;
  // A multi-step stage's agent steps run on these harnesses too, so each of their requests is narrowed as a call's is.
  const tracked = (harness: Harness) => (tracker === undefined ? harness : tracker.harness(harness));
  const named = (name: string): Harness => {
    const harness = opened.harnesses[name];
    if (harness === undefined) throw new Error(`the run holds no harness named '${name}', which its roster names`);
    return tracked(harness);
  };
  const on = { harness: tracked(opened.adapters.harness), ...(conventions === undefined ? {} : { conventions }) };
  if (entry?.steps !== undefined) {
    // A multi-step stage's roster holds each step's own model, and the named harness it runs on.
    const models = Object.fromEntries(
      entry.steps.flatMap((step) => (step.model === undefined ? [] : [[step.step, step.model] as const])),
    );
    const steps = Object.fromEntries(
      entry.steps.flatMap((step) =>
        step.harness === undefined ? [] : [[step.step, { harness: named(step.harness), name: step.harness }] as const],
      ),
    );
    const [first] = Object.values(models);
    if (first === undefined) throw new Error(`run.json's roster holds no model for an agent step of '${stage}'`);
    return { ...on, model: first, models, ...(Object.keys(steps).length === 0 ? {} : { steps }) };
  }
  const model = entry?.model;
  if (model === undefined) throw new Error(`run.json's roster holds no model for the agent stage '${stage}'`);
  return {
    ...(entry?.harness === undefined ? on : { ...on, harness: named(entry.harness), harnessName: entry.harness }),
    model,
  };
}

/** Whether a definition runs an agent anywhere: as itself, or as a step of its stage. */
const runsAgent = (definition: StageDefinition): boolean =>
  definition.kind === 'agent' ||
  (definition.kind === 'stage' && definition.steps.some((step) => step.kind === 'agent'));

/** The outcomes a step passes with, so the next step of its call runs. */
const PASSED = new Set(['done', 'passed']);

/** Whether `call`'s stage has a step after `step`. */
const stepFollows = (call: PendingCall, step: unknown): boolean => {
  const steps = call.definition.kind === 'stage' ? call.definition.steps : [];
  const index = steps.findIndex((each) => each.name === step);
  return index >= 0 && index < steps.length - 1;
};

/** The call key a step line's key belongs to: `publish#1` for `publish#1/describe`. */
const callKeyOf = (key: string): string => key.split('/')[0] ?? key;

/**
 * The step lines of `call` the journal holds, which must be its stage's first steps in order, none after one that
 * stopped the stage, or why they aren't. A one-step definition has none, and any line of one is a change. A call the
 * journal holds is checked as one still to run is: its stage may have changed since.
 */
function finishedSteps(
  call: Pick<PendingCall, 'key' | 'stage' | 'definition'>,
  entries: readonly JournalEntry[],
): JournalEntry[] | { failed: string } {
  const lines = entries.filter((entry) => entry.step !== undefined && callKeyOf(entry.key) === call.key);
  const steps = call.definition.kind === 'stage' && call.definition.steps.length > 1 ? call.definition.steps : [];
  for (const [index, line] of lines.entries()) {
    const step = steps[index];
    const before = lines[index - 1];
    if (step === undefined) {
      return { failed: `the journal has '${line.key}' where ${call.stage} has no step ${index + 1}` };
    }
    if (line.step !== step.name) {
      return { failed: `the journal has '${line.key}' where ${call.stage}'s step ${index + 1} is '${step.name}'` };
    }
    if (before !== undefined && before.outcome !== 'done' && before.outcome !== 'passed') {
      return {
        failed: `the journal has '${line.key}' after '${before.key}', which ended ${call.stage} ${before.outcome}`,
      };
    }
  }
  return lines;
}

/**
 * Races the replay against an interrupt and its minute budget. Both stops win only a task later, so a replay that
 * settles in microtasks still ends its own way. A timer that fires early re-arms from the tracker's remaining time.
 */
async function unlessStopped(
  replaying: Promise<ReplayEnd>,
  signal: AbortSignal | undefined,
  tracker: BudgetTracker | undefined,
): Promise<ReplayEnd | { stopped: 'interrupted' | 'budget' }> {
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let abandon = () => {};
  try {
    return await Promise.race([
      replaying,
      new Promise<{ stopped: 'interrupted' | 'budget' }>((resolve) => {
        abandon = () => {
          interruptTimer = setTimeout(() => resolve({ stopped: 'interrupted' }), 0);
        };
        if (signal?.aborted) abandon();
        else signal?.addEventListener('abort', abandon, { once: true });
        const arm = () => {
          const left = tracker?.minutesLeftMs();
          if (left === undefined) return;
          budgetTimer = setTimeout(
            () => {
              if (tracker?.over() !== undefined) resolve({ stopped: 'budget' });
              else arm();
            },
            Math.min(left, 2 ** 31 - 1),
          );
        };
        arm();
      }),
    ]);
  } finally {
    clearTimeout(interruptTimer);
    clearTimeout(budgetTimer);
    signal?.removeEventListener('abort', abandon);
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A completed run's `result` for `run:end`, serialised once and parsed back, or a `message` saying why it's left out. A
 * workflow may return anything: a result JSON can't hold, like a BigInt or a cyclic object, or one whose `toJSON` gives
 * a different answer the second time, would make `run:end` itself unwritable.
 */
function resultOf(result: unknown): { result?: unknown } | { message: string } {
  try {
    const text = JSON.stringify(result);
    return text === undefined ? {} : { result: JSON.parse(text) };
  } catch (error) {
    return { message: `the workflow's result can't be written as JSON: ${messageOf(error)}` };
  }
}

/**
 * The patch each gitDiff binding the call consumes stands for, taken from the run's workspace now, or why one can't be
 * taken. A diff that fails as a port fails names its binding; anything else is a bug in sail, and is thrown on.
 */
async function gitDiffs(
  opened: OpenedRun,
  call: PendingCall,
): Promise<{ supplied: Record<string, Supplied> } | { failed: string }> {
  const supplied: Record<string, Supplied> = {};
  // A stage of one step runs as that step, with its gitDiffs. A multi-step call takes each step's as the step starts.
  const definition = call.definition.kind === 'stage' ? (asStep(call.definition) ?? call.definition) : call.definition;
  for (const [key, binding] of Object.entries(definition.consumes)) {
    if (binding.kind !== 'gitDiff') continue;
    try {
      const { patch } = await opened.adapters.workspace.diff(opened.workspace.path, binding.range);
      supplied[key] = { kind: 'gitDiff', patch, from: `gitDiff(${binding.range})` };
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      return { failed: `'${key}': ${error.message} (${error.code})` };
    }
  }
  return { supplied };
}

/** Opens a run of the workflow and runs it to its end. A refusal to open passes through, and nothing is written. */
export async function runWorkflow(options: RunWorkflowOptions): Promise<RunEnd | { refused: string }> {
  return awake(options, async (hold) => {
    const opened = await openRun(options);
    if ('refused' in opened) return opened;
    return drive(opened, options, { start: true, hold });
  });
}

/**
 * Holds the run's keep-awake around `body`, from before the run opens until it has ended, whatever the end. A hold that
 * isn't held is no refusal: the run goes on, and says so.
 */
async function awake<T>(options: EventOptions, body: (hold: KeepAwakeHold) => Promise<T>): Promise<T> {
  const hold = (options.keepAwake ?? systemKeepAwake(process.env)).acquire();
  try {
    return await body(hold);
  } finally {
    hold.release();
  }
}

/**
 * The loop every run goes through: replay the journal, run the call the replay stopped at, journal it, again. An abort
 * seen before a call starts, or once it has returned, suspends the run with that call unjournaled, and so does one seen
 * while a replay hangs. A replay that ends the run ends it that way, aborted or not: nothing is left to resume.
 *
 * A run has one step before the loop: its intake, run and journaled as a call is unless the journal already starts
 * with it. The run goes on only if that entry passed.
 */
async function drive(
  opened: OpenedRun,
  options: DriveOptions,
  { start, hold }: { start: boolean; hold: KeepAwakeHold },
): Promise<RunEnd> {
  const { runId, dir, sailDir, loaded, header } = opened;
  const { signal, clock = systemClock } = options;
  const bus = createBus({
    runId,
    firstSeq: opened.firstSeq,
    now: clock,
    // The events file first: the summary seeds itself from it on a resume, and it must already hold the event in hand.
    consumers: [ndjsonConsumer(dir), summaryConsumer(dir), ...(options.consumers ?? [])],
    ...(options.unreported === undefined ? {} : { unreported: options.unreported }),
  });
  let replays = 0;
  /** The call being run or journaled, which a crash names and a provider event is stamped with. */
  let running: string | undefined;
  /** Set as `run:end` goes out: it ends the stream. */
  let ended = false;
  const replayEmit: Emit = (event) => {
    if (!ended) bus.emit(event);
  };
  const tracker = trackBudget({
    budget: header.budget,
    prior: start ? [] : readEvents(dir),
    emit: bus.emit,
    record: recordIn(dir),
    elapsed: () => performance.now(),
  });
  /** A call's events, folded into the run's budget as they go out. */
  const tapped: Emit = (event) => {
    const stamped = bus.emit(event);
    tracker?.observe(stamped);
  };
  const root = dirname(sailDir);
  /**
   * Emits what an adapter emitted, under the running call's key. A workspace event has none, nor one between calls, and
   * its path is relative to the repository root.
   */
  const relayed = (event: ProviderEvent): void => {
    if (ended) return;
    if (event.type.startsWith('workspace:')) {
      bus.emit(rootRelative(event, root) as NewEvent);
      return;
    }
    bus.emit((running === undefined ? event : { ...event, key: running }) as NewEvent);
  };
  const detach = opened.relay.attach(relayed);

  /**
   * Records how the run ended in STATUS, releases the workspace and the lease of a run that has ended for good, then
   * reports it.
   */
  const finish = async (end: RunEnd): Promise<RunEnd> => {
    writeStatus(dir, end.status, end.stopReason);
    const { status, stopReason } = end;
    let { message } = end;
    if (status !== 'suspended') {
      const { workspace } = opened;
      const run = { runId, runDir: dir };
      try {
        // A head nothing pushed is kept at its run ref, which workspace:released names: the message stays the run's.
        await opened.adapters.workspace.release(run, false);
      } catch (error) {
        if (!(error instanceof PortError)) throw error;
        const why = `its workspace at ${relative(root, workspace.path)} was not released: ${error.message}`;
        message = message === undefined ? why : `${message}; ${why}`;
      }
      try {
        await opened.adapters.workspace.releaseLease(workspace.remote, workspace.branch, runId);
      } catch (error) {
        if (!(error instanceof PortError)) throw error;
        const why = `its lease on ${workspace.branch} was not released: ${error.message}`;
        message = message === undefined ? why : `${message}; ${why}`;
      }
    }
    ended = true;
    bus.emit({
      type: 'run:end',
      status,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(message === undefined ? {} : { message }),
      ...(status === 'completed' ? resultOf(end.result) : {}),
      replays,
    });
    return end;
  };
  const failed = (stopReason: StopReason, message: string): Promise<RunEnd> =>
    finish({ runId, dir, status: 'failed', stopReason, message });
  const suspended = (stopReason: 'interrupted' | 'until' | 'unwatched', message: string): Promise<RunEnd> =>
    finish({ runId, dir, status: 'suspended', stopReason, message });
  /** How the run ends at the boundary before `key` once it has used up its budget, or undefined to go on. */
  const overBudget = (key: string, when?: 'before' | 'during'): Promise<RunEnd> | undefined => {
    tracker?.assertRecorded();
    const over = tracker?.over();
    if (over === undefined) return undefined;
    const { event, message } = suspension(over, key, when);
    bus.emit(event);
    return finish({ runId, dir, status: 'suspended', stopReason: 'budget_exceeded', message, budget: over.budget });
  };
  /** A call that ran out of the run's budget: an error over a budget the run narrowed. It is left unjournaled. */
  const ranOut = (result: Record<string, unknown>): boolean =>
    tracker?.narrowed(result.key as string) === true &&
    result.outcome === 'error' &&
    ((result.errors ?? []) as { reason: string }[]).some((error) => error.reason === 'budget_exceeded');
  /** A call (or a step of one) that hit the provider's usage limit: its call's key, and the reset time if given. */
  const limitedOf = (result: Record<string, unknown>): Limited | undefined => {
    if (result.outcome !== 'error') return undefined;
    const hit = ((result.errors ?? []) as { reason: string; resetsAt?: string }[]).find(
      (error) => error.reason === 'usage_limit',
    );
    if (hit === undefined) return undefined;
    return { key: callKeyOf(String(result.key)), ...(hit.resetsAt === undefined ? {} : { resetsAt: hit.resetsAt }) };
  };
  /** Suspends the run on the usage limit `limit`: the limited call is left unjournaled, and the workspace kept. */
  const limitReached = (limit: Limited): Promise<RunEnd> => {
    const { key, resetsAt } = limit;
    bus.emit({
      type: 'run:suspended',
      stopReason: 'usage_limit',
      key,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
    return finish({
      runId,
      dir,
      status: 'suspended',
      stopReason: 'usage_limit',
      message: `${key} hit the usage limit${resetsAt === undefined ? '' : `: it resets at ${resetsAt}`}`,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  };
  const interrupted = (message: string): Promise<RunEnd> => suspended('interrupted', message);
  const stopNow = new AbortController();
  let stoppedDuring: string | undefined;
  /** Poll only while a call runs; leave the request for the boundary to take. */
  const watchStop = (key: string) => {
    const poll = () => {
      if (stopNowRequested(dir) && !stopNow.signal.aborted) {
        stoppedDuring = key;
        stopNow.abort();
      }
    };
    const timer = setInterval(poll, 500);
    timer.unref();
    poll();
    return () => clearInterval(timer);
  };
  /** How the run ends at the boundary before `key`, when its control file asks it to, or undefined to go on. */
  const controlled = (key: string): Promise<RunEnd> | undefined => {
    const request = takeControl(dir);
    if (request === 'unwatched') return suspended('unwatched', `its workflow was unwatched: stopped before ${key}`);
    if (request === 'stopped')
      return failed(
        'stopped',
        stopNow.signal.aborted
          ? `stopped by sail stop --now during ${stoppedDuring ?? key}`
          : `stopped by sail stop before ${key}`,
      );
    return undefined;
  };
  /** How the run ends once `sail stop --now` aborted `key`: stopped, even with its control file gone by now. */
  const stoppedNow = (key: string): Promise<RunEnd> =>
    controlled(key) ?? failed('stopped', `stopped by sail stop --now during ${stoppedDuring ?? key}`);
  /** A call whose preconditions hold: what it is supplied with, what an agent runs on, and its steps journaled. */
  interface Ready {
    call: PendingCall;
    supplied: Record<string, Supplied>;
    agent: AgentExecution | undefined;
    finished: JournalEntry[];
  }
  /** The call's agent execution, its gitDiff patches and its contract's check, or why it can't run. */
  const prepare = async (call: PendingCall, finished: JournalEntry[]): Promise<Ready | { failed: string }> => {
    const agent = runsAgent(call.definition)
      ? executionOf(opened, call.stage, header.stages[call.stage], tracker)
      : undefined;
    const diffs = await gitDiffs(opened, call);
    if ('failed' in diffs) return diffs;
    const supplied = { ...call.supplied, ...diffs.supplied };
    const problems = callProblems(call.definition, supplied, agent);
    return problems.length > 0 ? { failed: problems.join('; ') } : { call, supplied, agent, finished };
  };
  /** Runs the call's next try: a multi-step call from the first step not journaled, journaling each as it ends. */
  const launch = async ({ call, supplied, agent, finished }: Ready, callSignal: AbortSignal | undefined) => {
    callSignal = AbortSignal.any([stopNow.signal, ...(callSignal === undefined ? [] : [callSignal])]);
    const clear = watchStop(call.key);
    try {
      return await runCall(
        {
          runDir: dir,
          runId,
          stageIndex: call.stageIndex,
          call: call.call,
          try: nextTry(dir, call.stageIndex, call.stage, call.call),
          definition: call.definition,
          stageFile: copiedStageFile(dir, header.stages[call.stage]?.origin, call.stageFile),
          workspace: opened.workspace.path,
          root,
          branch: opened.workspace.branch,
          config: join(sailDir, 'project.yaml'),
          supplied,
          ...(callSignal === undefined ? {} : { signal: callSignal }),
          ...(agent === undefined ? {} : { agent }),
          emit: tapped,
          clock,
        },
        {
          finished,
          // A step that ends once the run is stopping isn't journaled: a resume runs it again. Nor is one that ran out of
          // the run's budget, which stops its call as a call is left: the next replay asks for the call again, and it runs
          // from that step. The budget is checked before each further step as before each call: once a step that passed
          // has used it up, the next doesn't start, and the boundary before the call suspends the run.
          onStep: (result, paths) => {
            if (callSignal?.aborted || ranOut(result) || limitedOf(result) !== undefined) return false;
            journal(result, paths);
            if (callSignal?.aborted) return false;
            return !(
              PASSED.has(String(result.outcome)) &&
              stepFollows(call, result.step) &&
              tracker?.over() !== undefined
            );
          },
          diff: async (range) => (await opened.adapters.workspace.diff(opened.workspace.path, range)).patch,
        },
      );
    } finally {
      clear();
    }
  };
  /** Journals a call that ran, with its group's keys when it has a group, and reports it. */
  const journal = (result: Record<string, unknown>, paths: CallPaths, group?: string[]): JournalEntry => {
    tracker?.assertRecorded();
    const journaled = appendJournal(dir, entryFrom(dir, result, paths, group), clock());
    bus.emit({ type: 'journal:append', key: journaled.key, line: journaled.seq, outcome: journaled.outcome });
    reached ||= journaled.key === last;
    return journaled;
  };
  /**
   * Runs a repository intake's steps as the call `intake#1`, from the run's source, or says why they can't. Only the
   * call's line is journaled, not each step's, so the journal's head stays `intake#1`: a call stopped part way runs
   * again from its first step, at the next try.
   */
  const runOwnIntake = async (own: LoadedIntake): Promise<Ran | { failed: string }> => {
    const { definition, path } = own;
    const stage = ownIntakeStage(definition);
    const agent = runsAgent(stage) ? executionOf(opened, INTAKE_STAGE, header.intake, tracker) : undefined;
    const supplied: Record<string, Supplied> = Object.hasOwn(stage.consumes, 'source')
      ? { source: { kind: 'value', value: header.source, from: 'run.json#/source' } }
      : {};
    const problems = callProblems(stage, supplied, agent);
    if (problems.length > 0) return { failed: `the intake '${definition.name}' can't run: ${problems.join('; ')}` };
    const live = path === undefined || path.endsWith('.ts') ? (path ?? '') : join(path, 'intake.ts');
    const callSignal = AbortSignal.any([stopNow.signal, ...(signal === undefined ? [] : [signal])]);
    const clear = watchStop(INTAKE_KEY);
    try {
      return await runCall(
        {
          runDir: dir,
          runId,
          stageIndex: INTAKE_INDEX,
          call: 1,
          try: nextTry(dir, INTAKE_INDEX, INTAKE_STAGE, 1),
          definition: stage,
          stageFile: copiedIntakeFile(dir, header.intake.origin, live),
          workspace: opened.workspace.path,
          root,
          branch: opened.workspace.branch,
          config: join(sailDir, 'project.yaml'),
          supplied,
          signal: callSignal,
          ...(agent === undefined ? {} : { agent }),
          emit: intakeEmit(tapped, definition, header.intake.origin),
          clock,
        },
        { diff: async (range) => (await opened.adapters.workspace.diff(opened.workspace.path, range)).patch },
      );
    } finally {
      clear();
    }
  };
  /** The key whose journaling stops the run at the next call it asks for: the first call of the stage `until` names. */
  const last = opened.until === undefined ? undefined : `${opened.until}#1`;
  let reached = false;
  /** A seeded run's source and stage, until its first replay has asked for a call of its own. */
  let seededFor = opened.seeded;

  try {
    if (start) {
      // From the header, never derived again: the roster in the stream is the one frozen in run.json.
      bus.emit({
        type: 'run:start',
        source: header.source,
        workflow: header.workflow,
        roster: { intake: header.intake, stages: header.stages },
        adapters: header.adapters,
        ...(header.budget === undefined ? {} : { budget: header.budget }),
        ...(header.fromRun === undefined ? {} : { fromRun: header.fromRun }),
      });
    }
    // What opening the run did, before this stream existed to hear it: the lease and the workspace. No call was
    // running, so no key.
    for (const event of opened.started) bus.emit(event);
    if (opened.raise !== undefined) tracker?.raise(opened.raise);
    // A seeded run's reused calls, each once: they were journaled as the run opened, with no stream to hear them.
    if (opened.seeded !== undefined) {
      const { fromRun, entries, ticket } = opened.seeded;
      for (const { key, seq, outcome } of entries) {
        const named = key === INTAKE_KEY && ticket !== undefined ? { ticket } : {};
        bus.emit({ type: 'journal:append', key, line: seq, outcome, fromRun, ...named });
      }
    }
    // After the opening's events, so a resume's budget segment still starts at its renewed lease.
    bus.emit(
      hold.held
        ? { type: 'run:keep_awake', held: true, by: hold.by }
        : { type: 'run:keep_awake', held: false, reason: hold.reason },
    );
    await options.onOpened?.();
    // The intake, before any workflow code: taken from the head of the journal, or run and journaled there.
    let [intake] = readJournal(dir).entries;
    if (intake === undefined) {
      const body = intakeBody(loaded.intake);
      if (signal?.aborted) return await interrupted(`stopped before ${INTAKE_KEY}`);
      const beforeIntake = controlled(INTAKE_KEY) ?? overBudget(INTAKE_KEY);
      if (beforeIntake !== undefined) return await beforeIntake;
      running = INTAKE_KEY;
      const ran =
        body === undefined
          ? await runOwnIntake(loaded.intake)
          : await runIntake({
              runDir: dir,
              runId,
              intake: loaded.intake,
              body,
              source: header.source,
              ticketSource: opened.adapters.ticketSource,
              codeHost: opened.adapters.codeHost,
              workspace: { port: opened.adapters.workspace, path: opened.workspace.path },
              branchPrefix: opened.config.branchPrefix ?? DEFAULT_BRANCH_PREFIX,
              try: nextTry(dir, INTAKE_INDEX, INTAKE_STAGE, 1),
              ...(signal === undefined ? {} : { signal }),
              emit: bus.emit,
              clock,
            });
      if ('failed' in ran) return await failed('stage_error', ran.failed);
      if (stopNow.signal.aborted) return await stoppedNow(INTAKE_KEY);
      if (signal?.aborted || ('stopped' in ran && ran.stopped))
        return await interrupted(`stopped during ${INTAKE_KEY}`);
      intake = journal(ran.result, ran.paths);
      running = undefined;
      options.onCall?.(intake);
    } else if (intake.key !== INTAKE_KEY) {
      const { source } = header;
      const from = source.kind === 'ticket' ? `ticket ${source.ticketKey}` : `pull request #${source.number}`;
      const message = `the journal of a run from ${from} starts with '${intake.key}', not '${INTAKE_KEY}'`;
      return await failed('determinism_violation', message);
    }
    // Checked on every start, not only when the intake just ran: a crash between the journal line and STATUS must
    // not replay a workflow that has no input.
    if (!PASSED.has(intake.outcome)) {
      const why = intakeFailure(loaded.intake.definition.name, intake.outcome, intake.reason ?? '');
      return await failed('stage_error', why);
    }
    while (true) {
      replays++;
      // The input is the journal's first line as read back, for a fresh run and a resume alike: the intake's output in
      // memory may hold what JSON drops, and a resume would then replay on another object than the run that wrote it.
      // Nothing stands in for that line: a journal that has lost it can't be trusted.
      const [journaledIntake, ...lines] = readJournal(dir).entries;
      if (journaledIntake?.key !== INTAKE_KEY) {
        const why = `is no longer ${INTAKE_KEY}: the journal changed under the run`;
        throw new JournalError(join(dir, JOURNAL_FILE), 1, why);
      }
      // The replay goes by position over calls: a step's line is its call's to read, never the replay's.
      const entries = lines.filter((line) => line.step === undefined);
      const replaying = replay({
        workflow: loaded.workflow,
        stages: loaded.stages,
        runDir: dir,
        entries,
        intake: journaledIntake,
        emit: replayEmit,
      });
      const end = await unlessStopped(replaying, signal, tracker);
      if ('stopped' in end) {
        if (end.stopped === 'interrupted') return await interrupted('stopped during the replay');
        const budgetEnd = overBudget('the replay', 'during');
        if (budgetEnd === undefined) throw new Error('replay stopped without an exceeded budget');
        return await budgetEnd;
      }
      // Every step line belongs to a call the journal holds, or to one the workflow asks for now.
      const asked = new Set(end.kind === 'call' ? [end.call.key] : end.kind === 'group' ? end.keys : []);
      const held = new Set(entries.map((entry) => entry.key));
      const stray = lines.find(
        (line) => line.step !== undefined && !held.has(callKeyOf(line.key)) && !asked.has(callKeyOf(line.key)),
      );
      if (stray !== undefined) {
        const message = `the journal holds '${stray.key}' of a call the workflow didn't ask for`;
        return await failed('determinism_violation', message);
      }
      // A call the journal holds keeps the steps it ran with: one whose stage renamed, reordered or dropped them since
      // replays against lines its stage no longer has.
      for (const entry of entries) {
        const definition = loaded.stages.find((each) => each.definition.name === entry.stage)?.definition;
        const checked = definition === undefined ? [] : finishedSteps({ ...entry, definition }, lines);
        if ('failed' in checked) return await failed('determinism_violation', checked.failed);
      }
      // A seeded run's first call of its own is the stage it was seeded for: an edited workflow that asks for another
      // first, or ends, would run what nobody asked for.
      if (seededFor !== undefined) {
        const { fromRun, stage } = seededFor;
        seededFor = undefined;
        const expected = `${stage}#1`;
        const first = end.kind === 'call' && end.call.key === expected;
        const grouped = end.kind === 'group' && end.keys.includes(expected);
        if (end.kind !== 'failed' && !first && !grouped) {
          const asked =
            end.kind === 'call'
              ? `asks for ${end.call.key}`
              : end.kind === 'group'
                ? `asks for the group ${end.keys.join(', ')}`
                : 'ends';
          const message = `the workflow ${asked} after the calls reused from run ${fromRun}, not ${expected}: it changed since that run`;
          return await failed('determinism_violation', message);
        }
      }
      if (end.kind === 'completed') return await finish({ runId, dir, status: 'completed', result: end.result });
      if (end.kind === 'failed') return await failed(end.stopReason, end.message);
      const first = end.kind === 'call' ? end.call.key : (end.keys[0] as string);
      // Ahead of an abort seen at the same moment: the run stopped where it was asked to, whatever else stops it. A
      // control request goes first: a stop asked during the call `--until` names ends the run, not waits with it.
      if (reached) return await (controlled(first) ?? suspended('until', `stopped after ${last}, as --until asked`));
      const calls = end.kind === 'call' ? [end.call] : end.calls;
      if (end.kind === 'call') running = first;
      // Every call's preconditions before any starts: a group that can't run starts nothing.
      const ready: Ready[] = [];
      for (const call of calls) {
        const finished = finishedSteps(call, lines);
        if ('failed' in finished) return await failed('determinism_violation', finished.failed);
        const checked = await prepare(call, finished);
        if ('failed' in checked) return await failed('workflow_failed', `${call.key} can't run: ${checked.failed}`);
        ready.push(checked);
      }
      const what = end.kind === 'call' ? first : `the group ${end.keys.join(', ')}`;
      if (signal?.aborted) return await interrupted(`stopped before ${what}`);
      const beforeCall = controlled(first) ?? overBudget(what);
      if (beforeCall !== undefined) return await beforeCall;
      if (end.kind === 'call') {
        const [one] = ready as [Ready];
        const { result, paths, stopped } = await launch(one, signal);
        if (signal?.aborted) return await interrupted(`stopped during ${first}`);
        const limit = limitedOf(result);
        if (limit !== undefined) {
          running = undefined;
          return await limitReached(limit);
        }
        if (stopNow.signal.aborted) {
          running = undefined;
          return await stoppedNow(first);
        }
        // Stopped short of its last step, the call is left for the next replay to ask for again.
        if (stopped === true || ranOut(result)) {
          running = undefined;
          continue;
        }
        const journaled = journal(result, paths);
        running = undefined;
        options.onCall?.(journaled);
        continue;
      }
      const { keys } = end;
      bus.emit({ type: 'all:start', keys, running: calls.map((call) => call.key) });
      const startedAt = clock().getTime();
      // A call that throws, a bug in sail, stops its siblings: the error goes on once every one of them has settled.
      const crash = new AbortController();
      const groupSignal = AbortSignal.any([stopNow.signal, crash.signal, ...(signal === undefined ? [] : [signal])]);
      const live = new Set(calls.map((call) => call.key));
      /** The calls this process journaled: once it holds them all, the journal holds the group whole. */
      let journaledNow = 0;
      /** The first call of the group that hit the usage limit. */
      let usageLimited: Limited | undefined;
      // A resume may run one call of a group, and it isn't the group's first.
      running = live.size === 1 ? [...live][0] : undefined;
      /** The relay's key is the running call's while exactly one of the group's runs, and none otherwise. */
      const settle = (each: Ready) => {
        live.delete(each.call.key);
        running = live.size === 1 ? [...live][0] : undefined;
      };
      const settled = await Promise.allSettled(
        ready.map(async (each) => {
          try {
            const { result, paths, stopped } = await launch(each, groupSignal);
            // A call that returns once the run is stopping isn't journaled: a resume runs it again.
            if (groupSignal.aborted) return;
            const limit = limitedOf(result);
            if (limit !== undefined) {
              usageLimited ??= limit;
              return;
            }
            if (stopped === true || ranOut(result)) return;
            const journaled = journal(result, paths, keys);
            journaledNow++;
            settle(each);
            options.onCall?.(journaled);
          } catch (error) {
            crash.abort();
            throw error;
          } finally {
            settle(each);
          }
        }),
      );
      running = undefined;
      // A group the journal holds whole has ended, even when an abort or a crash came after its last call: no replay
      // reports it again, so this is its only all:end. A report that fails gives way to a call's crash, which is the
      // run's cause; with no call crashed, the failure is the run's crash.
      const rejected = settled.find((each): each is PromiseRejectedResult => each.status === 'rejected');
      if (journaledNow === calls.length) {
        try {
          const journaled = new Map(readJournal(dir).entries.map((entry) => [entry.key, entry.outcome]));
          const outcomes = Object.fromEntries(keys.map((key) => [key, journaled.get(key) as JournalEntry['outcome']]));
          bus.emit({ type: 'all:end', keys, outcomes, durationMs: Math.max(0, clock().getTime() - startedAt) });
        } catch (error) {
          throw rejected === undefined ? error : rejected.reason;
        }
      }
      if (rejected !== undefined) throw rejected.reason;
      if (signal?.aborted) return await interrupted(`stopped during ${what}`);
      if (stopNow.signal.aborted) return await stoppedNow(first);
      if (usageLimited !== undefined) return await limitReached(usageLimited);
    }
  } catch (error) {
    bus.emit({ type: 'error:crash', message: messageOf(error), ...(running === undefined ? {} : { key: running }) });
    throw error;
  } finally {
    detach();
  }
}

/**
 * Opens a run seeded with another run's calls before a stage and runs it, to the end of that stage's first call or,
 * with `continue`, to its end. A refusal to open passes through, and nothing is written.
 */
export async function runSeededWorkflow(options: SeededWorkflowOptions): Promise<RunEnd | { refused: string }> {
  return awake(options, async (hold) => {
    const opened = await openSeededRun(options);
    if ('refused' in opened) return opened;
    return drive(opened, options, { start: true, hold });
  });
}

/** Reopens a suspended or crashed run and runs it to its end from its journal. A refusal passes through. */
export async function resumeWorkflow(options: ResumeWorkflowOptions): Promise<RunEnd | { refused: string }> {
  return awake(options, async (hold) => {
    const opened = await reopenRun(options);
    if ('refused' in opened) return opened;
    return drive(opened, options, { start: false, hold });
  });
}
