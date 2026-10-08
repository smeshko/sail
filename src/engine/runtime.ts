// Runs a workflow to its end: open the run, then loop. Each turn replays the workflow against the journal, runs the call
// the replay stopped at, and journals it, until a replay ends the run and STATUS records how. Start, continue and resume
// are this one loop: a resume enters it with an existing run directory. Until runs get a workspace of their own,
// scripts run in the directory that holds `.sail/`.
//
// A run runs its intake before the first replay and journals it as `intake#1`, the journal's first line.
// Every replay is handed that entry beside the stage entries, so a resume reads the input from the journal and never
// fetches the ticket again. An intake that didn't pass fails the run with `stage_error`: no workflow code has run, and
// nothing can route on it.
//
// What the adapters emit while the run is going reaches its stream through the relay, stamped with the key of the call
// that is running. A workspace event carries none. The claim is made before the run directory exists, so a fresh run
// reports it from its result, right after `run:start` and with no key: `ticket:claimed`, or `ticket:updated` for a
// forced move, then `ticket:commented`. A resume reports none of it again.
//
// An abort stops the running call and suspends the run with `interrupted`. The interrupted call is left unjournaled, so
// a resume runs it again as its next try. An abort also stops a replay that hangs in the workflow's own code, since
// Ctrl-C no longer ends the process once sail listens for it. One seen while a fresh run is being opened, before its
// ticket is claimed, refuses the start instead: nothing was written, so there is no run to suspend.
//
// `until` names a stage to stop after. Once that stage's first call is journaled the next replay still runs: if it
// ends the run, the run ends that way, and if it asks for another call the run is suspended with `until` instead, where
// an abort seen before a call suspends it. A resume takes none and runs to the end.
//
// An exception inside sail, such as a journal that can't be trusted or a bug in a call, propagates and leaves STATUS
// `running`: writing it may be what failed, and a `running` run with no process is how a dead one looks.
//
// Every event of the run goes through one bus to `events.ndjson`, then to `summary.json`, which is rewritten after every
// call, and then to any consumers passed in. The runtime emits
// `run:start` for a fresh run, `journal:append` for each call it journals, `run:end` once STATUS says how the run
// ended, and `error:crash` before an exception inside sail propagates. The call emits its own events, and the replay
// the loop and route events of the moves past the journal's end. A resume continues the file's `seq` with no marker.
// `run:end` ends the stream: a replay an abort abandoned may move on once its workflow stops waiting, since the CLI
// only sets an exit code, but nothing it reports after that is emitted.
import { dirname, join } from 'node:path';
import { createBus } from '../events/bus';
import { ndjsonConsumer } from '../events/consumers/ndjson';
import { summaryConsumer } from '../events/consumers/summary';
import type { Consumer, Emit, NewEvent, ProviderEvent, SailEvent } from '../events/types';
import { type AgentExecution, callProblems, runCall } from './call';
import { type CallPaths, nextTry, runRelative } from './call-dir';
import { INTAKE_INDEX, INTAKE_KEY, INTAKE_STAGE, intakeBody, runIntake } from './intake';
import { appendJournal, type JournalEntry, type NewJournalEntry, readJournal } from './journal';
import { type OpenedRun, type OpenRunOptions, openRun, type ReopenRunOptions, reopenRun } from './open-run';
import { type ReplayEnd, replay } from './replay';
import { type StopReason, writeStatus } from './run-dir';

/** Who else receives a run's events, beside `events.ndjson`. */
interface EventOptions {
  /** Consumers that receive every event after the events file and the summary. */
  consumers?: readonly Consumer[];
  /** Where a consumer's throw on an `error:consumer` event goes. Stderr by default. */
  unreported?: (error: unknown, consumer: Consumer, event: SailEvent) => void;
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
}

export interface RunWorkflowOptions extends OpenRunOptions, EventOptions {
  /**
   * Stops the running call when it aborts, and suspends the run. Aborted before the ticket is claimed, it refuses the
   * start.
   */
  signal?: AbortSignal;
  /** Called after each call is journaled. */
  onCall?(entry: JournalEntry): void;
}

export interface ResumeWorkflowOptions extends ReopenRunOptions, EventOptions {
  /** Stops the running call when it aborts, and suspends the run again. */
  signal?: AbortSignal;
  /** Called after each call is journaled. */
  onCall?(entry: JournalEntry): void;
}

/** What drives an opened run, whether it started or resumed. */
interface DriveOptions extends EventOptions {
  signal?: AbortSignal;
  onCall?(entry: JournalEntry): void;
}

/** Why a call ended as it did, for the workflow: an error's problems, each with its reason, or a blocked agent's own. */
function reasonOf(result: Record<string, unknown>): string | null {
  if (result.outcome === 'blocked') return String(result.reason);
  if (result.outcome !== 'error') return null;
  const errors = (result.errors ?? []) as { reason: string; message: string }[];
  return errors.map(({ reason, message }) => `${reason}: ${message}`).join('; ');
}

/** The journal entry of a call that ran, from its `result.json`. */
function entryFrom(runDir: string, result: Record<string, unknown>, paths: CallPaths): NewJournalEntry {
  const files = result.files as Record<string, { path: string }>;
  return {
    key: result.key as string,
    stage: result.stage as string,
    call: result.call as number,
    outcome: result.outcome as JournalEntry['outcome'],
    output: result.output,
    reason: reasonOf(result),
    files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.path])),
    resultPath: runRelative(runDir, paths.result),
  };
}

/**
 * What an agent call runs on: the run's harness, the conventions `project.yaml` lists now, and the model the run's
 * roster froze at its start, which a resume keeps whatever the alias names by then.
 */
function executionOf(opened: OpenedRun, stage: string): AgentExecution {
  const model = opened.header.stages[stage]?.model;
  if (model === undefined) throw new Error(`run.json's roster holds no model for the agent stage '${stage}'`);
  const { conventions } = opened.config;
  return { harness: opened.adapters.harness, model, ...(conventions === undefined ? {} : { conventions }) };
}

/**
 * How the replay ended, or undefined when `signal` aborted while it hung in the workflow's own code. The abort only wins
 * a task later: a replay settles in microtasks, so one that ends the run still ends it when the abort came first.
 */
function unlessAborted(replaying: Promise<ReplayEnd>, signal: AbortSignal | undefined): Promise<ReplayEnd | undefined> {
  if (signal === undefined) return replaying;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abandon = () => {
      timer = setTimeout(() => resolve(undefined), 0);
    };
    if (signal.aborted) abandon();
    else signal.addEventListener('abort', abandon, { once: true });
    replaying.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abandon);
    });
  });
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

/** Opens a run of the workflow and runs it to its end. A refusal to open passes through, and nothing is written. */
export async function runWorkflow(options: RunWorkflowOptions): Promise<RunEnd | { refused: string }> {
  const opened = await openRun(options);
  if ('refused' in opened) return opened;
  return drive(opened, options, { start: true });
}

/**
 * The loop every run goes through: replay the journal, run the call the replay stopped at, journal it, again. An abort
 * seen before a call starts, or once it has returned, suspends the run with that call unjournaled, and so does one seen
 * while a replay hangs. A replay that ends the run ends it that way, aborted or not: nothing is left to resume.
 *
 * A run has one step before the loop: its intake, run and journaled as a call is unless the journal already starts
 * with it. The run goes on only if that entry passed.
 */
async function drive(opened: OpenedRun, options: DriveOptions, { start }: { start: boolean }): Promise<RunEnd> {
  const { runId, dir, sailDir, loaded, header } = opened;
  const { signal } = options;
  const bus = createBus({
    runId,
    firstSeq: opened.firstSeq,
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
  /** Emits what an adapter emitted, under the running call's key. A workspace event has none, nor one between calls. */
  const relayed = (event: ProviderEvent): void => {
    if (ended) return;
    const keyed = running !== undefined && !event.type.startsWith('workspace:');
    bus.emit((keyed ? { ...event, key: running } : event) as NewEvent);
  };
  const detach = opened.relay.attach(relayed);

  /** Records how the run ended in STATUS, then reports it. */
  const finish = (end: RunEnd): RunEnd => {
    writeStatus(dir, end.status, end.stopReason);
    const { status, stopReason, message } = end;
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
  const failed = (stopReason: StopReason, message: string): RunEnd =>
    finish({ runId, dir, status: 'failed', stopReason, message });
  const suspended = (stopReason: 'interrupted' | 'until', message: string): RunEnd =>
    finish({ runId, dir, status: 'suspended', stopReason, message });
  const interrupted = (message: string): RunEnd => suspended('interrupted', message);
  /** The key whose journaling stops the run at the next call it asks for: the first call of the stage `until` names. */
  const last = opened.until === undefined ? undefined : `${opened.until}#1`;
  let reached = false;

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
      });
      // What the claim did to the ticket, before this stream existed to hear it. No call was running, so no key.
      for (const event of opened.claimed) bus.emit(event);
    }
    // The intake, before any workflow code: taken from the head of the journal, or run and journaled there.
    let [intake] = readJournal(dir).entries;
    if (intake === undefined) {
      const body = intakeBody(loaded.intake);
      if (body === undefined) {
        const name = loaded.intake.definition.name;
        return failed('stage_error', `${INTAKE_KEY} can't run: the intake '${name}' is the repository's own`);
      }
      if (signal?.aborted) return interrupted(`stopped before ${INTAKE_KEY}`);
      running = INTAKE_KEY;
      const { result, paths } = await runIntake({
        runDir: dir,
        runId,
        intake: loaded.intake,
        body,
        source: header.source,
        ticketSource: opened.adapters.ticketSource,
        try: nextTry(dir, INTAKE_INDEX, INTAKE_STAGE, 1),
        ...(signal === undefined ? {} : { signal }),
        emit: bus.emit,
      });
      if (signal?.aborted) return interrupted(`stopped during ${INTAKE_KEY}`);
      intake = appendJournal(dir, entryFrom(dir, result, paths));
      bus.emit({ type: 'journal:append', key: intake.key, line: intake.seq, outcome: intake.outcome });
      running = undefined;
      options.onCall?.(intake);
    } else if (intake.key !== INTAKE_KEY) {
      const { ticketKey } = header.source;
      const message = `the journal of a run from ticket ${ticketKey} starts with '${intake.key}', not '${INTAKE_KEY}'`;
      return failed('determinism_violation', message);
    }
    // Checked on every start, not only when the intake just ran: a crash between the journal line and STATUS must
    // not replay a workflow that has no input.
    if (intake.outcome !== 'passed') {
      return failed('stage_error', `${INTAKE_KEY} ended in ${intake.outcome}: ${intake.reason ?? ''}`);
    }
    while (true) {
      replays++;
      // The input is the journal's first line as read back, for a fresh run and a resume alike: the intake's output in
      // memory may hold what JSON drops, and a resume would then replay on another object than the run that wrote it.
      const [journaledIntake = intake, ...entries] = readJournal(dir).entries;
      const replaying = replay({
        workflow: loaded.workflow,
        stages: loaded.stages,
        runDir: dir,
        entries,
        intake: journaledIntake,
        emit: replayEmit,
      });
      const end = await unlessAborted(replaying, signal);
      if (end === undefined) return interrupted('stopped during the replay');
      if (end.kind === 'completed') return finish({ runId, dir, status: 'completed', result: end.result });
      if (end.kind === 'failed') return failed(end.stopReason, end.message);

      const { call } = end;
      // Ahead of an abort seen at the same moment: the run stopped where it was asked to, whatever else stops it.
      if (reached) return suspended('until', `stopped after ${last}, as --until asked`);
      running = call.key;
      const agent = call.definition.kind === 'agent' ? executionOf(opened, call.stage) : undefined;
      const problems = callProblems(call.definition, call.supplied, agent);
      if (problems.length > 0) return failed('workflow_failed', `${call.key} can't run: ${problems.join('; ')}`);
      if (signal?.aborted) return interrupted(`stopped before ${call.key}`);
      const { result, paths } = await runCall({
        runDir: dir,
        runId,
        stageIndex: call.stageIndex,
        call: call.call,
        try: nextTry(dir, call.stageIndex, call.stage, call.call),
        definition: call.definition,
        stageFile: call.stageFile,
        workspace: dirname(sailDir),
        config: join(sailDir, 'project.yaml'),
        supplied: call.supplied,
        ...(signal === undefined ? {} : { signal }),
        ...(agent === undefined ? {} : { agent }),
        emit: bus.emit,
      });
      if (signal?.aborted) return interrupted(`stopped during ${call.key}`);
      const journaled = appendJournal(dir, entryFrom(dir, result, paths));
      bus.emit({ type: 'journal:append', key: journaled.key, line: journaled.seq, outcome: journaled.outcome });
      running = undefined;
      reached ||= journaled.key === last;
      options.onCall?.(journaled);
    }
  } catch (error) {
    bus.emit({ type: 'error:crash', message: messageOf(error), ...(running === undefined ? {} : { key: running }) });
    throw error;
  } finally {
    detach();
  }
}

/** Reopens a suspended or crashed run and runs it to its end from its journal. A refusal passes through. */
export async function resumeWorkflow(options: ResumeWorkflowOptions): Promise<RunEnd | { refused: string }> {
  const opened = await reopenRun(options);
  if ('refused' in opened) return opened;
  return drive(opened, options, { start: false });
}
