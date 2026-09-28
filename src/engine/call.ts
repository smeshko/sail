// One call of a stage, start to finish: create its call directory, materialise its bindings into `$STAGE_IN`, run its
// step through the kind the definition names, then validate and write `result.json`. `sail stage run` calls it for a
// stage in isolation, and Epic 03's replay loop for each call of a run.
import { dirname } from 'node:path';
import type { CallEmit, Emit, NewEvent } from '../events/types';
import { KINDS } from '../kinds/index';
import type { StageDefinition } from '../sdk/steps';
import { bindingProblems, materialise, type Supplied } from './bindings';
import { type CallPaths, callPaths, createCallDir, runRelative } from './call-dir';
import type { JournalEntry } from './journal';
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
  /** Where the call's events go, each keyed `<stage>#<call>`. `sail stage run` passes none. */
  emit?: Emit;
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
  const key = `${definition.name}#${call}`;
  const emit: CallEmit = (event) => request.emit?.({ ...event, key } as NewEvent);
  const stage = { stage: definition.name, call, try: tryNumber };
  const bound = Object.keys(definition.consumes).filter((binding) => Object.hasOwn(request.supplied, binding));
  // Before the call directory exists, so a call that crashes creating it still shows it started.
  emit({
    type: 'stage:start',
    ...stage,
    kind: definition.kind,
    consumed: Object.fromEntries(bound.map((binding) => [binding, request.supplied[binding]?.from ?? null])),
  });
  const paths = callPaths(runDir, request.stageIndex, definition.name, call, tryNumber);
  createCallDir(paths);
  const { inputs, consumed } = materialise(definition.consumes, request.supplied, paths.stageIn);
  for (const [binding, from] of Object.entries(consumed)) {
    if (from !== null) emit({ type: 'input:materialised', binding, from });
  }
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
    emit,
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
  emit({
    type: 'stage:end',
    ...stage,
    outcome: run.outcome as JournalEntry['outcome'],
    durationMs: result.durationMs as number,
    resultPath: runRelative(runDir, paths.result),
    ...(run.outcome === 'error' ? { errors: run.errors } : {}),
  });
  return { result, paths };
}
