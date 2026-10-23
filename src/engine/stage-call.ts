// A multi-step stage's call: its steps in order, sharing the call's `$STAGE_OUT`. TDD stub (ADW-112): the signatures
// TASK-004 implements, each returning a value no test expects.

import type { Stage } from '../sdk/steps';
import type { CallRequest, Ran } from './call';
import { type CallPaths, callPaths } from './call-dir';
import type { JournalEntry } from './journal';

/** What a multi-step call is told by the one who runs it, and tells it back. */
export interface StageHooks {
  /** The steps already journaled for this call, in order, as their journal lines: skipped, and read from. */
  finished?: readonly JournalEntry[];
  /**
   * Called once a step that wasn't interrupted has written its `result.json` and ended: the runtime journals it. A
   * `false` return stops the call there, and so does a throw, which goes on to the caller.
   */
  onStep?(result: Record<string, unknown>, paths: CallPaths): boolean | undefined;
  /** The patch of a step's `gitDiff(range)`, taken now. Left out, a step that declares one can't start. */
  diff?(range: string): Promise<string>;
}

/** What is wrong with how a multi-step stage wires its steps, one message each. TDD stub: nothing. */
export function stepProblems(_stage: Stage): string[] {
  return [];
}

/** Runs a multi-step stage's call. TDD stub: runs nothing, and returns an empty result. */
export async function runStageCall(request: CallRequest, _stage: Stage, _hooks: StageHooks = {}): Promise<Ran> {
  return { result: {}, paths: callPaths(request.runDir, request.stageIndex, request.definition.name, request.call) };
}
