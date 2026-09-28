// Runs a workflow to its end: open the run, then loop. Each turn replays the workflow against the journal, runs the call
// the replay stopped at, and journals it, until a replay ends the run and STATUS records how. Start, continue and resume
// are this one loop: a resume enters it with an existing run directory. Until runs get a workspace of their own,
// scripts run in the directory that holds `.sail/`.
//
// An abort stops the running call and suspends the run with `interrupted`. The interrupted call is left unjournaled, so
// a resume runs it again as its next try. An abort also stops a replay that hangs in the workflow's own code, since
// Ctrl-C no longer ends the process once sail listens for it.
//
// An exception inside sail, such as a journal that can't be trusted or a bug in a call, propagates and leaves STATUS
// `running`: writing it may be what failed, and a `running` run with no process is how a dead one looks.
//
// Every event of the run goes through one bus to `events.ndjson` and any consumers passed in. The runtime emits
// `run:start` for a fresh run, `journal:append` for each call it journals, `run:end` once STATUS says how the run
// ended, and `error:crash` before an exception inside sail propagates. The call emits its own events, and the replay
// the loop and route events of the moves past the journal's end. A resume continues the file's `seq` with no marker.
import { dirname, join } from 'node:path';
import { createBus } from '../events/bus';
import { ndjsonConsumer } from '../events/consumers/ndjson';
import type { Consumer, SailEvent } from '../events/types';
import { callProblems, runCall } from './call';
import { type CallPaths, nextTry, runRelative } from './call-dir';
import { appendJournal, type JournalEntry, type NewJournalEntry, readJournal } from './journal';
import { type OpenedRun, type OpenRunOptions, openRun, type ReopenRunOptions, reopenRun } from './open-run';
import { type ReplayEnd, replay } from './replay';
import { type StopReason, writeStatus } from './run-dir';

/** Who else receives a run's events, beside `events.ndjson`. */
interface EventOptions {
  /** Consumers that receive every event after the events file. */
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
  /** Stops the running call when it aborts, and suspends the run. */
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

/** The journal entry of a call that ran, from its `result.json`. An error's `reason` is its errors' messages. */
function entryFrom(runDir: string, result: Record<string, unknown>, paths: CallPaths): NewJournalEntry {
  const files = result.files as Record<string, { path: string }>;
  const errors = (result.errors ?? []) as { reason: string; message: string }[];
  return {
    key: result.key as string,
    stage: result.stage as string,
    call: result.call as number,
    outcome: result.outcome as JournalEntry['outcome'],
    output: result.output,
    reason: result.outcome === 'error' ? errors.map(({ reason, message }) => `${reason}: ${message}`).join('; ') : null,
    files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.path])),
    resultPath: runRelative(runDir, paths.result),
  };
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
 */
async function drive(opened: OpenedRun, options: DriveOptions, { start }: { start: boolean }): Promise<RunEnd> {
  const { runId, dir, sailDir, loaded, input, header } = opened;
  const { signal } = options;
  const bus = createBus({
    runId,
    firstSeq: opened.firstSeq,
    consumers: [ndjsonConsumer(dir), ...(options.consumers ?? [])],
    ...(options.unreported === undefined ? {} : { unreported: options.unreported }),
  });
  let replays = 0;
  /** The call being run or journaled, which a crash names. */
  let running: string | undefined;

  /** Records how the run ended in STATUS, then reports it. */
  const finish = (end: RunEnd): RunEnd => {
    writeStatus(dir, end.status, end.stopReason);
    const { status, stopReason, message } = end;
    bus.emit({
      type: 'run:end',
      status,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(message === undefined ? {} : { message }),
      ...(status === 'completed' ? { result: end.result } : {}),
      replays,
    });
    return end;
  };
  const failed = (stopReason: StopReason, message: string): RunEnd =>
    finish({ runId, dir, status: 'failed', stopReason, message });
  const suspended = (message: string): RunEnd =>
    finish({ runId, dir, status: 'suspended', stopReason: 'interrupted', message });

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
    }
    while (true) {
      const { entries } = readJournal(dir);
      replays++;
      const replaying = replay({
        workflow: loaded.workflow,
        stages: loaded.stages,
        entries,
        runDir: dir,
        input,
        emit: bus.emit,
      });
      const end = await unlessAborted(replaying, signal);
      if (end === undefined) return suspended('stopped during the replay');
      if (end.kind === 'completed') return finish({ runId, dir, status: 'completed', result: end.result });
      if (end.kind === 'failed') return failed(end.stopReason, end.message);

      const { call } = end;
      running = call.key;
      const problems = callProblems(call.definition, call.supplied);
      if (problems.length > 0) return failed('workflow_failed', `${call.key} can't run: ${problems.join('; ')}`);
      if (signal?.aborted) return suspended(`stopped before ${call.key}`);
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
        emit: bus.emit,
      });
      if (signal?.aborted) return suspended(`stopped during ${call.key}`);
      const journaled = appendJournal(dir, entryFrom(dir, result, paths));
      bus.emit({ type: 'journal:append', key: journaled.key, line: journaled.seq, outcome: journaled.outcome });
      running = undefined;
      options.onCall?.(journaled);
    }
  } catch (error) {
    bus.emit({ type: 'error:crash', message: messageOf(error), ...(running === undefined ? {} : { key: running }) });
    throw error;
  }
}

/** Reopens a suspended or crashed run and runs it to its end from its journal. A refusal passes through. */
export async function resumeWorkflow(options: ResumeWorkflowOptions): Promise<RunEnd | { refused: string }> {
  const opened = await reopenRun(options);
  if ('refused' in opened) return opened;
  return drive(opened, options, { start: false });
}
