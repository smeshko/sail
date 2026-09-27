// Runs a workflow to its end: open the run, then loop. Each turn replays the workflow against the journal, runs the call
// the replay stopped at, and journals it, until a replay ends the run and STATUS records how. Start and continue are
// this one loop, and phase 3.3's resume enters it with an existing run directory. Until runs get a workspace of their
// own, scripts run in the directory that holds `.sail/`.
//
// An exception inside sail, such as a journal that can't be trusted or a bug in a call, propagates and leaves STATUS
// `running`: writing it may be what failed, and a `running` run with no process is how a dead one looks.
import { dirname, join } from 'node:path';
import { callProblems, runCall } from './call';
import { type CallPaths, runRelative } from './call-dir';
import { appendJournal, type JournalEntry, type NewJournalEntry, readJournal } from './journal';
import { type OpenRunOptions, openRun } from './open-run';
import { replay } from './replay';
import { type StopReason, writeStatus } from './run-dir';

/** How a run ended. */
export interface RunEnd {
  runId: string;
  dir: string;
  status: 'completed' | 'failed';
  stopReason?: StopReason;
  /** Why a failed run stopped, for people. */
  message?: string;
  /** What the workflow returned, when it completed. */
  result?: unknown;
}

export interface RunWorkflowOptions extends OpenRunOptions {
  /** Called after each call is journaled. */
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

/** Opens a run of the workflow and runs it to its end. A refusal to open passes through, and nothing is written. */
export async function runWorkflow(options: RunWorkflowOptions): Promise<RunEnd | { refused: string }> {
  const opened = await openRun(options);
  if ('refused' in opened) return opened;
  const { runId, dir, sailDir, loaded, input } = opened;
  const failed = (stopReason: StopReason, message: string): RunEnd => {
    writeStatus(dir, 'failed', stopReason);
    return { runId, dir, status: 'failed', stopReason, message };
  };

  while (true) {
    const { entries } = readJournal(dir);
    const end = await replay({ workflow: loaded.workflow, stages: loaded.stages, entries, runDir: dir, input });
    if (end.kind === 'completed') {
      writeStatus(dir, 'completed');
      return { runId, dir, status: 'completed', result: end.result };
    }
    if (end.kind === 'failed') return failed(end.stopReason, end.message);

    const { call } = end;
    const problems = callProblems(call.definition, call.supplied);
    if (problems.length > 0) return failed('workflow_failed', `${call.key} can't run: ${problems.join('; ')}`);
    const { result, paths } = await runCall({
      runDir: dir,
      runId,
      stageIndex: call.stageIndex,
      call: call.call,
      definition: call.definition,
      stageFile: call.stageFile,
      workspace: dirname(sailDir),
      config: join(sailDir, 'project.yaml'),
      supplied: call.supplied,
    });
    const journaled = appendJournal(dir, entryFrom(dir, result, paths));
    options.onCall?.(journaled);
  }
}
