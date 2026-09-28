// One call of a stage, start to finish: create its call directory, materialise its bindings into `$STAGE_IN`, run its
// step through the kind the definition names, then validate and write `result.json`. `sail stage run` calls it for a
// stage in isolation, and Epic 03's replay loop for each call of a run.
import { dirname } from 'node:path';
import { KINDS } from '../kinds/index';
import type { StageDefinition } from '../sdk/steps';
import { bindingProblems, materialise, type Supplied } from './bindings';
import { type CallPaths, callPaths, createCallDir } from './call-dir';
import { buildResult, writeResult } from './result';

export interface CallRequest {
  runDir: string;
  runId: string;
  /** The stage's `NN` in the run directory. */
  stageIndex: number;
  call: number;
  /** The call's try: 1, the default, unless an earlier try was interrupted. */
  try?: number;
  definition: StageDefinition;
  /** The `stage.ts` that exported the definition: a script's `run` is relative to its directory. */
  stageFile: string;
  workspace: string;
  /** `project.yaml`. */
  config: string;
  supplied: Record<string, Supplied>;
  signal?: AbortSignal;
  graceMs?: number;
}

/** Why the definition can't run with what is supplied, found before anything is written. */
export function callProblems(definition: StageDefinition, supplied: Readonly<Record<string, Supplied>>): string[] {
  if (definition.kind === 'agent') return ["agent steps can't run yet"];
  if (definition.kind === 'stage') return ["multi-step stages can't run yet"];
  return [...KINDS[definition.kind].problems(definition), ...bindingProblems(definition.consumes, supplied)];
}

/** Runs one call and writes its `result.json`. Callers check `callProblems` first: any problem throws here. */
export async function runCall(request: CallRequest): Promise<{ result: Record<string, unknown>; paths: CallPaths }> {
  const { definition, runDir, runId, call } = request;
  const problems = callProblems(definition, request.supplied);
  if (problems.length > 0 || definition.kind !== 'script') throw new Error(problems.join('\n'));

  const tryNumber = request.try ?? 1;
  const paths = callPaths(runDir, request.stageIndex, definition.name, call, tryNumber);
  createCallDir(paths);
  const { inputs, consumed } = materialise(definition.consumes, request.supplied, paths.stageIn);
  const startedAt = new Date();
  const run = await KINDS[definition.kind].run(definition, {
    runId,
    runDir,
    stage: definition.name,
    call,
    try: tryNumber,
    stageDir: dirname(request.stageFile),
    workspace: request.workspace,
    config: request.config,
    paths,
    inputs,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.graceMs === undefined ? {} : { graceMs: request.graceMs }),
  });
  const finishedAt = new Date();
  const result = buildResult({
    runId,
    stage: definition.name,
    call,
    kind: definition.kind,
    run,
    consumed,
    startedAt,
    finishedAt,
  });
  writeResult(paths.result, result);
  return { result, paths };
}
