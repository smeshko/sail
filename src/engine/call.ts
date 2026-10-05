// One call of a stage, start to finish: create its call directory, materialise its bindings into `$STAGE_IN`, run its
// step through the kind the definition names, then validate and write `result.json`. `sail stage run` calls it for a
// stage in isolation, and Epic 03's replay loop for each call of a run.
//
// An agent call may take two tries of its own: when the agent's output breaks its schema or leaves a declared file out,
// a second try runs with the problems appended to its prompt, once. That one correction belongs to the call, not to the
// process: the tries a call has already made are read back from their `result.json`s, so a resume neither loses the
// correction nor gets another. What a crash left unsaid of those tries in the events is said first.
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readEvents } from '../events/consumers/ndjson';
import type { CallEmit, CallEvent, Emit, NewEvent } from '../events/types';
import { KINDS, type StepRun } from '../kinds/index';
import type { Harness } from '../ports/harness';
import type { Usage } from '../ports/types';
import type { AgentStep, StageDefinition } from '../sdk/steps';
import { bindingProblems, materialise, materialisePrepared, prepareBindings, type Supplied } from './bindings';
import { type CallPaths, callPaths, createCallDir, existingTries, runRelative } from './call-dir';
import type { ContractError } from './contract';
import type { JournalEntry } from './journal';
import { buildResult, writeResult } from './result';
import { formatIssue, validateDocument } from './schemas';

/** What an agent call runs on, resolved by its caller before anything is written. */
export interface AgentExecution {
  harness: Harness;
  /** The model id the step's alias resolved to. A resumed run passes the one its roster froze. */
  model: string;
  /** `project.yaml`'s `conventions`. Left out, the defaults are appended. */
  conventions?: readonly string[];
}

export interface CallRequest {
  runDir: string;
  runId: string;
  /** The stage's `NN` in the run directory. */
  stageIndex: number;
  call: number;
  /**
   * The try the call starts at: 1, the default, unless an earlier try was interrupted. An agent call that corrects
   * invalid output goes on to the next try itself.
   */
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
  /** What an agent call runs on. A script call takes none. */
  agent?: AgentExecution;
}

/** Why an agent call with no `AgentExecution` can't run: its caller resolved no harness and no model for it. */
const UNRESOLVED = "agent steps need a harness and a model, which weren't resolved";

/** Why the definition can't run with what is supplied, found before anything is written. */
export function callProblems(
  definition: StageDefinition,
  supplied: Readonly<Record<string, Supplied>>,
  agent?: AgentExecution,
): string[] {
  if (definition.kind === 'stage') return ["multi-step stages can't run yet"];
  if (definition.kind === 'agent' && agent === undefined) return [UNRESOLVED];
  const own = definition.kind === 'agent' ? KINDS.agent.problems(definition) : KINDS.script.problems(definition);
  return [...own, ...bindingProblems(definition.consumes, supplied)];
}

type Ran = { result: Record<string, unknown>; paths: CallPaths };

/** Which try of which call. */
interface TryOf {
  stage: string;
  call: number;
  try: number;
}

/** Where each binding that was supplied came from, as a try's `stage:start` says before anything is materialised. */
function suppliedFrom(definition: StageDefinition, supplied: Record<string, Supplied>): Record<string, string | null> {
  const bound = Object.keys(definition.consumes).filter((binding) => Object.hasOwn(supplied, binding));
  return Object.fromEntries(bound.map((binding) => [binding, supplied[binding]?.from ?? null]));
}

const errorsOf = (result: Record<string, unknown>): ContractError[] => (result.errors ?? []) as ContractError[];

/** A try's `stage:end`, from its result: one just written, or one a recovered call found on disk. */
function stageEnd(of: TryOf, result: Record<string, unknown>, resultPath: string): CallEvent {
  return {
    type: 'stage:end',
    ...of,
    outcome: result.outcome as JournalEntry['outcome'],
    durationMs: result.durationMs as number,
    resultPath,
    ...(result.outcome === 'error' ? { errors: errorsOf(result) } : {}),
  };
}

/** Runs one call and writes its `result.json`. Callers check `callProblems` first: any problem throws here. */
export async function runCall(request: CallRequest): Promise<Ran> {
  const { definition } = request;
  const problems = callProblems(definition, request.supplied, request.agent);
  if (problems.length > 0 || definition.kind === 'stage') throw new Error(problems.join('\n'));
  if (definition.kind === 'agent') return runAgentCall(request, definition, request.agent as AgentExecution);

  const { runDir, runId, call } = request;
  const tryNumber = request.try ?? 1;
  const key = `${definition.name}#${call}`;
  const emit: CallEmit = (event) => request.emit?.({ ...event, key } as NewEvent);
  const stage = { stage: definition.name, call, try: tryNumber };
  // Before the call directory exists, so a call that crashes creating it still shows it started.
  emit({
    type: 'stage:start',
    ...stage,
    kind: definition.kind,
    consumed: suppliedFrom(definition, request.supplied),
  });
  const paths = callPaths(runDir, request.stageIndex, definition.name, call, tryNumber);
  createCallDir(paths);
  const { inputs, consumed } = materialise(definition.consumes, request.supplied, paths.stageIn);
  for (const [binding, from] of Object.entries(consumed)) {
    if (from !== null) emit({ type: 'input:materialised', binding, from });
  }
  const startedAt = new Date();
  const run = await KINDS.script.run(definition, {
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
  emit(stageEnd(stage, result, runRelative(runDir, paths.result)));
  return { result, paths };
}

/** A try an agent call has already made: its directory, and its result when it wrote one. */
interface PriorTry {
  try: number;
  paths: CallPaths;
  result?: Record<string, unknown>;
}

/**
 * The tries a call has made, in order, each with the result it left. A result that can't be read, or isn't an agent
 * step's, throws: its try may have used the call's one correction, and nothing else says so.
 */
function priorTries(request: CallRequest, stage: string): PriorTry[] {
  const { runDir, stageIndex, call } = request;
  return existingTries(runDir, stageIndex, stage, call).map((tryNumber) => {
    const paths = callPaths(runDir, stageIndex, stage, call, tryNumber);
    if (!existsSync(paths.result)) return { try: tryNumber, paths };
    const refused = (why: string) => new Error(`${runRelative(runDir, paths.result)} ${why}, so its call can't go on`);
    let result: unknown;
    try {
      result = JSON.parse(readFileSync(paths.result, 'utf8'));
    } catch (error) {
      throw refused(`can't be read (${(error as Error).message})`);
    }
    const issues = validateDocument('sail.result.v1', result);
    if (issues.length > 0) throw refused(`breaks sail.result.v1 (${issues.map(formatIssue).join('; ')})`);
    const read = result as Record<string, unknown>;
    if (read.kind !== 'agent') throw refused("is not an agent step's result");
    return { try: tryNumber, paths, result: read };
  });
}

const CORRECTABLE = new Set(['invalid_output', 'missing_file']);

/**
 * Whether a try's output was checked and found wanting. A result from before the field existed counts when every one
 * of its errors is one a correction is for.
 */
function failedValidation(result: Record<string, unknown>): boolean {
  if (typeof result.validationFailed === 'boolean') return result.validationFailed;
  const errors = errorsOf(result);
  return result.outcome === 'error' && errors.length > 0 && errors.every((error) => CORRECTABLE.has(error.reason));
}

/** `errors` without the ones that repeat an earlier one. */
function distinct(errors: readonly ContractError[]): ContractError[] {
  return errors.filter(
    (error, index) =>
      errors.findIndex((other) => other.reason === error.reason && other.message === error.message) === index,
  );
}

/**
 * The end of the session a try's result records: what it spent is the result's to say. A try whose output was checked
 * ended its session `done`, and the error is the engine's verdict on what it submitted.
 */
function sessionEndOf(result: Record<string, unknown>): CallEvent {
  const { sessionId, turns, toolCalls, denials } = result.harness as {
    sessionId?: string;
    turns: number;
    toolCalls: number;
    denials: number;
  };
  return {
    type: 'harness:session_end',
    ...(sessionId === undefined ? {} : { sessionId }),
    outcome: failedValidation(result) ? 'done' : (result.outcome as 'done' | 'blocked' | 'error'),
    turns,
    toolCalls,
    denials,
    usage: result.usage as Usage,
  };
}

/**
 * Says what a crash left unsaid of the tries already made: the end of a session that started and never ended, and the
 * `stage:end` of a result that has none. The events file is never synced, so a result on disk is the authority on its
 * session, and the session's last usage update stands in only for a try that left no result. Each event is emitted
 * once: the next recovery finds it in the events.
 */
function reconcile(request: CallRequest, stage: string, key: string, tries: readonly PriorTry[], emit: CallEmit): void {
  const events = readEvents(request.runDir).filter((event) => 'key' in event && event.key === key);
  for (const prior of tries) {
    // A try's events run from its `stage:start` to the next. The last one for the try: an earlier one is what a crash
    // left before the try had a directory.
    const from = events.findLastIndex((event) => event.type === 'stage:start' && event.try === prior.try);
    if (from < 0) continue;
    const next = events.findIndex((event, index) => index > from && event.type === 'stage:start');
    const own = events.slice(from, next < 0 ? undefined : next);
    const started = own.findLast((event) => event.type === 'harness:session_start');
    const { result } = prior;
    if (started !== undefined && !own.some((event) => event.type === 'harness:session_end')) {
      if (result !== undefined) emit(sessionEndOf(result));
      else {
        const updated = own.findLast((event) => event.type === 'usage:update');
        emit({
          type: 'harness:session_end',
          sessionId: started.sessionId,
          outcome: 'error',
          reason: 'interrupted',
          turns: updated?.turn ?? 0,
          toolCalls: own.filter((event) => event.type === 'tool:start').length,
          denials: own.filter((event) => event.type === 'permission:denied').length,
          usage:
            updated === undefined
              ? { costUsd: 0 }
              : {
                  inputTokens: updated.tokens.input,
                  cacheReadTokens: updated.tokens.cacheRead,
                  cacheWriteTokens: updated.tokens.cacheWrite,
                  outputTokens: updated.tokens.output,
                  costUsd: updated.costUsdSoFar,
                },
        });
      }
    }
    if (result !== undefined && !own.some((event) => event.type === 'stage:end')) {
      const of = { stage, call: request.call, try: prior.try };
      emit(stageEnd(of, result, runRelative(request.runDir, prior.paths.result)));
    }
  }
}

/**
 * Runs an agent call: one try, and a second when the first's output was checked and found wanting, unless the step
 * says `fail`. It takes up where the call's earlier tries left it.
 */
async function runAgentCall(request: CallRequest, definition: AgentStep, agent: AgentExecution): Promise<Ran> {
  const { runDir, runId, call } = request;
  const key = `${definition.name}#${call}`;
  const emit: CallEmit = (event) => request.emit?.({ ...event, key } as NewEvent);
  const corrects = (definition.onInvalidOutput ?? 'retry-once') === 'retry-once';
  const tries = priorTries(request, definition.name);
  // A call with nowhere to emit has no events to set right.
  if (tries.length > 0 && request.emit !== undefined) reconcile(request, definition.name, key, tries, emit);

  /** The problems of the try whose output was checked and found wanting, which the next try is told. */
  let found: ContractError[] | undefined;
  for (const prior of tries) {
    if (prior.result === undefined || !failedValidation(prior.result)) continue;
    // The call has had its last word, and only its journal line is missing: its correction failed too, or it gets none.
    if (prior.result.validationTry === 2 || !corrects) return { result: prior.result, paths: prior.paths };
    found = errorsOf(prior.result);
  }

  // Parsed once for the call: each try gets a `$STAGE_IN` of its own, and the same values.
  const bindings = prepareBindings(definition.consumes, request.supplied);
  let tryNumber = Math.max(request.try ?? 1, (tries.at(-1)?.try ?? 0) + 1);
  while (true) {
    const stage = { stage: definition.name, call, try: tryNumber };
    // Before the call directory exists, so a call that crashes creating it still shows it started.
    emit({
      type: 'stage:start',
      ...stage,
      kind: 'agent',
      model: agent.model,
      consumed: suppliedFrom(definition, request.supplied),
      permissions: definition.permissions,
      budget: definition.budget,
    });
    const paths = callPaths(runDir, request.stageIndex, definition.name, call, tryNumber);
    createCallDir(paths, { durable: true });
    const { inputs, consumed } = materialisePrepared(bindings, paths.stageIn);
    for (const [binding, from] of Object.entries(consumed)) {
      if (from !== null) emit({ type: 'input:materialised', binding, from });
    }
    const startedAt = new Date();
    const ran = await KINDS.agent.run(definition, {
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
      emit,
      agent: {
        harness: agent.harness,
        model: agent.model,
        bindings,
        ...(agent.conventions === undefined ? {} : { conventions: agent.conventions }),
        validationTry: found === undefined ? 1 : 2,
        ...(found === undefined ? {} : { feedback: found.map((error) => error.message) }),
      },
    });
    const finishedAt = new Date();
    // No corrective try starts once the call is aborted: the try keeps its place, and a resume corrects it.
    const corrected =
      corrects && found === undefined && ran.record.validationFailed === true && request.signal?.aborted !== true;
    // A try that is corrected says what it got wrong. The call's last try also says what it was correcting.
    const errors = corrected ? ran.errors : distinct([...(found ?? []), ...ran.errors]);
    const run: StepRun = ran.outcome === 'error' ? { ...ran, errors } : ran;
    const result = buildResult({
      runId,
      stage: definition.name,
      call,
      kind: 'agent',
      run,
      consumed,
      startedAt,
      finishedAt,
    });
    // On disk, whole and synced, before another session starts: it is what a resume reads the call's place from.
    writeResult(paths.result, result, { durable: true });
    emit(stageEnd(stage, result, runRelative(runDir, paths.result)));
    // Checked again now that the try has ended: whoever heard its end may have aborted the call.
    if (!corrected || request.signal?.aborted === true) return { result, paths };
    found = ran.errors;
    tryNumber++;
  }
}
