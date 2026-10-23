// One call of a stage, start to finish: create its call directory, materialise its bindings into `$STAGE_IN`, run its
// step through the kind the definition names, then validate and write `result.json`. `sail stage run` calls it for a
// stage in isolation, and Epic 03's replay loop for each call of a run. A multi-step stage's call is `stage-call.ts`'s
// to sequence: this module runs one step's tries, whether the step is a call's only one or one of a stage's.
//
// An agent call may take two tries of its own: when the agent's output breaks its schema or leaves a declared file out,
// a second try runs with the problems appended to its prompt, once. That one correction belongs to the call, not to the
// process: the tries a call has already made are read back from their `result.json`s, so a resume neither loses the
// correction nor gets another. What a crash left unsaid of those tries in the events is said first. An agent step of a
// multi-step call gets the same: its tries sit in its own step directory, and its events are `step:start` and
// `step:end` under its key.
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readEvents } from '../events/consumers/ndjson';
import type { CallEmit, CallEvent, Emit, NewEvent, SailEvent } from '../events/types';
import { KINDS, type StepRun } from '../kinds/index';
import type { Harness } from '../ports/harness';
import type { Usage } from '../ports/types';
import type { AgentStep, ScriptStep, Stage, StageDefinition } from '../sdk/steps';
import { bindingProblems, materialise, materialisePrepared, prepareBindings, type Supplied } from './bindings';
import { type CallPaths, callPaths, createCallDir, existingTries, runRelative } from './call-dir';
import { type Clock, systemClock } from './clock';
import type { ContractError } from './contract';
import type { JournalEntry } from './journal';
import { buildResult, writeResult } from './result';
import { formatIssue, validateDocument } from './schemas';
import { runStageCall, type StageHooks } from './stage-call';

/** What an agent call runs on, resolved by its caller before anything is written. */
export interface AgentExecution {
  harness: Harness;
  /** The model id the step's alias resolved to. A resumed run passes the one its roster froze. */
  model: string;
  /**
   * A multi-step stage's: the model id of each agent step, by step name, as its roster froze them. A step it doesn't
   * name runs on `model`.
   */
  models?: Readonly<Record<string, string>>;
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
  /** Where the call's step runs. */
  workspace: string;
  /** The directory that holds `.sail/`: what the call records paths relative to. */
  root: string;
  /** The run's branch. Empty for a stage run in isolation. */
  branch: string;
  /** `project.yaml`. */
  config: string;
  supplied: Record<string, Supplied>;
  signal?: AbortSignal;
  graceMs?: number;
  /** Where the call's events go, each keyed `<stage>#<call>`. `sail stage run` passes none. */
  emit?: Emit;
  /** What an agent call runs on. A script call takes none. */
  agent?: AgentExecution;
  /** The clock each try's `startedAt` and `finishedAt` are read from, and its step's. The system's by default. */
  clock?: Clock;
}

/** Why an agent call with no `AgentExecution` can't run: its caller resolved no harness and no model for it. */
const UNRESOLVED = "agent steps need a harness and a model, which weren't resolved";

/**
 * A stage of one step as that step: under the stage's name, with the stage's bindings and, beside its own, the stage's
 * `produces`. It runs and records as the step would, and writes no `steps/` (D12).
 */
export function asStep(stage: Stage): AgentStep | ScriptStep | undefined {
  const [only, ...more] = stage.steps;
  if (more.length > 0) return undefined;
  return { ...withStageProduces(only, stage), name: stage.name, consumes: stage.consumes } as AgentStep | ScriptStep;
}

/**
 * The last step of `stage` as it runs: recording the stage's own `produces` beside its own (D9). A name both declare
 * keeps the step's document: the stage's plain `'file'` would drop its template and validators.
 */
export function withStageProduces<S extends AgentStep | ScriptStep>(step: S, stage: Stage): S {
  const produces: Record<string, unknown> = { ...step.produces };
  for (const [name, declared] of Object.entries(stage.produces)) {
    if (!Object.hasOwn(produces, name) || produces[name] === 'file') produces[name] = declared;
  }
  return { ...step, produces };
}

/** Why the definition can't run with what is supplied, found before anything is written. */
export function callProblems(
  definition: StageDefinition,
  supplied: Readonly<Record<string, Supplied>>,
  agent?: AgentExecution,
): string[] {
  if (definition.kind === 'stage') {
    const one = asStep(definition);
    if (one !== undefined) return callProblems(one, supplied, agent);
    const last = definition.steps.length - 1;
    // The last step is checked as it runs: with the stage's own produces.
    const steps = definition.steps.map((step, index) => (index === last ? withStageProduces(step, definition) : step));
    if (agent === undefined && steps.some((step) => step.kind === 'agent')) return [UNRESOLVED];
    const own = steps.flatMap((step) =>
      (step.kind === 'agent' ? KINDS.agent.problems(step) : KINDS.script.problems(step)).map(
        (problem) => `step '${step.name}': ${problem}`,
      ),
    );
    return [...own, ...bindingProblems(definition.consumes, supplied)];
  }
  if (definition.kind === 'agent' && agent === undefined) return [UNRESOLVED];
  const own = definition.kind === 'agent' ? KINDS.agent.problems(definition) : KINDS.script.problems(definition);
  return [...own, ...bindingProblems(definition.consumes, supplied)];
}

/** What a call left: its `result.json` and where it is. `stopped` when a multi-step call stopped short of one. */
export type Ran = { result: Record<string, unknown>; paths: CallPaths; stopped?: true };

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
export async function runCall(request: CallRequest, hooks: StageHooks = {}): Promise<Ran> {
  const problems = callProblems(request.definition, request.supplied, request.agent);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const definition = request.definition.kind === 'stage' ? asStep(request.definition) : request.definition;
  if (definition === undefined) return runStageCall(request, request.definition as Stage, hooks);
  const one = { ...request, definition };
  if (definition.kind === 'agent') {
    const agent = request.agent as AgentExecution;
    return runAgentTries(one, definition, agent, callSite(one, definition), request.supplied);
  }
  const { call } = request;
  const tryNumber = request.try ?? 1;
  const stage = { stage: definition.name, call, try: tryNumber };
  return runScriptTry(one, definition, request.supplied, {
    key: `${definition.name}#${call}`,
    paths: callPaths(request.runDir, request.stageIndex, definition.name, call, tryNumber),
    try: tryNumber,
    start: { type: 'stage:start', ...stage, kind: 'script', consumed: suppliedFrom(definition, request.supplied) },
    end: (result, resultPath) => stageEnd(stage, result, resultPath),
  });
}

/** Where a script step's one try runs, and how it is reported: a one-step call's, or a step's of a multi-step call. */
export interface ScriptTry {
  key: string;
  /** The step's name, which its result records, for a step of a multi-step call. */
  step?: string;
  paths: CallPaths;
  try: number;
  start: CallEvent;
  end(result: Record<string, unknown>, resultPath: string): CallEvent;
}

/** Runs one try of a script step, with `supplied` for its bindings, and writes its `result.json`. */
export async function runScriptTry(
  request: CallRequest,
  definition: ScriptStep,
  supplied: Readonly<Record<string, Supplied>>,
  at: ScriptTry,
): Promise<Ran> {
  const { runDir, runId, call } = request;
  const { key, paths } = at;
  const emit: CallEmit = (event) => request.emit?.({ ...event, key } as NewEvent);
  // Before the call directory exists, so a call that crashes creating it still shows it started.
  emit(at.start);
  createCallDir(paths);
  const { inputs, consumed } = materialise(definition.consumes, supplied, paths.stageIn);
  for (const [binding, from] of Object.entries(consumed)) {
    if (from !== null) emit({ type: 'input:materialised', binding, from });
  }
  const clock = request.clock ?? systemClock;
  const startedAt = clock();
  const run = await KINDS.script.run(definition, {
    runId,
    runDir,
    stage: request.definition.name,
    call,
    key,
    try: at.try,
    stageDir: dirname(request.stageFile),
    workspace: request.workspace,
    root: request.root,
    branch: request.branch,
    config: request.config,
    paths,
    inputs,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.graceMs === undefined ? {} : { graceMs: request.graceMs }),
    emit,
    clock,
  });
  const finishedAt = clock();
  const result = buildResult({
    runId,
    stage: request.definition.name,
    call,
    ...(at.step === undefined ? {} : { step: at.step }),
    kind: 'script',
    run,
    consumed,
    startedAt,
    finishedAt,
  });
  writeResult(paths.result, result);
  emit(at.end(result, runRelative(runDir, paths.result)));
  return { result, paths };
}

/**
 * Where an agent step's tries run and how they are reported: a one-step call's, in `call-N/` and its `try-M/`s under
 * `stage:start` and `stage:end`, or a step's of a multi-step call, in its step directory under `step:start` and
 * `step:end`. Its key is what every event of a try, and its harness request, carries.
 */
export interface TrySite {
  key: string;
  /** The step's name, which its result records, for a step of a multi-step call. */
  step?: string;
  paths(tryNumber: number): CallPaths;
  /** The tries on disk, in order. */
  tries(): number[];
  /** The event that starts a try: what it runs on, and what it consumes. */
  start(tryNumber: number): CallEvent;
  /** The event that ends a try, from its result: one just written, or one a recovered call found on disk. */
  end(tryNumber: number, result: Record<string, unknown>, resultPath: string): CallEvent;
  /** The type of `start`'s and `end`'s events, which recovery reads a try's events by. */
  starts: 'stage:start' | 'step:start';
}

/** A one-step agent call's site: its tries in `call-N/`, under `stage:start` and `stage:end`. */
function callSite(request: CallRequest, definition: AgentStep): TrySite {
  const { runDir, stageIndex, call } = request;
  const stage = definition.name;
  const model = (request.agent as AgentExecution).model;
  return {
    key: `${stage}#${call}`,
    paths: (tryNumber) => callPaths(runDir, stageIndex, stage, call, tryNumber),
    tries: () => existingTries(runDir, stageIndex, stage, call),
    start: (tryNumber) => ({
      type: 'stage:start',
      stage,
      call,
      try: tryNumber,
      kind: 'agent',
      model,
      consumed: suppliedFrom(definition, request.supplied),
      permissions: definition.permissions,
      budget: definition.budget,
    }),
    end: (tryNumber, result, resultPath) => stageEnd({ stage, call, try: tryNumber }, result, resultPath),
    starts: 'stage:start',
  };
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
function priorTries(runDir: string, site: TrySite): PriorTry[] {
  return site.tries().map((tryNumber) => {
    const paths = site.paths(tryNumber);
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
 * of its errors is one a correction is for. Only a try that ended in `error` failed anything: a later try's directory
 * is inside `$STAGE_OUT`, where a session can write, and a record that says it failed and is `done` is none of the
 * engine's.
 */
function failedValidation(result: Record<string, unknown>): boolean {
  if (result.outcome !== 'error') return false;
  if (typeof result.validationFailed === 'boolean') return result.validationFailed;
  const errors = errorsOf(result);
  return errors.length > 0 && errors.every((error) => CORRECTABLE.has(error.reason));
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

/** The end of a session a killed process left open, from what `own`, its try's events, hold of it. */
function interruptedEnd(sessionId: string, own: readonly SailEvent[]): CallEvent {
  const updated = own.findLast((event) => event.type === 'usage:update');
  return {
    type: 'harness:session_end',
    sessionId,
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
  };
}

/**
 * Says what a crash left unsaid of the tries already made: the end of a session that never ended, the end of a result
 * that has none, and the start of a try whose events were lost whole. The events file is never synced, so a result on
 * disk is the authority on its try, whatever the events kept of it, and a session's last usage update stands in only
 * for a try that left no result. Each event is emitted once: the next recovery finds it in the events, after the start
 * of its try.
 */
function reconcile(runDir: string, site: TrySite, tries: readonly PriorTry[], emit: CallEmit): void {
  const ends = site.starts === 'stage:start' ? 'stage:end' : 'step:end';
  const events = readEvents(runDir).filter((event) => 'key' in event && event.key === site.key);
  for (const prior of tries) {
    const { result } = prior;
    // A try's events run from its start to the next. The last one for the try: an earlier one is what a crash left
    // before the try had a directory.
    const from = events.findLastIndex((event) => event.type === site.starts && event.try === prior.try);
    const next = events.findIndex((event, index) => index > from && event.type === site.starts);
    const own = from < 0 ? [] : events.slice(from, next < 0 ? undefined : next);
    if (from < 0) {
      // Nothing in the events, and nothing on disk to say what the try did.
      if (result === undefined) continue;
      emit(site.start(prior.try));
    }
    const started = own.findLast((event) => event.type === 'harness:session_start');
    if (!own.some((event) => event.type === 'harness:session_end')) {
      // A try with a prompt asked its harness, whether or not the events kept the session's start.
      if (result === undefined) {
        if (started !== undefined) emit(interruptedEnd(started.sessionId, own));
      } else if (result.prompt !== undefined || started !== undefined) emit(sessionEndOf(result));
    }
    if (result !== undefined && !own.some((event) => event.type === ends)) {
      emit(site.end(prior.try, result, runRelative(runDir, prior.paths.result)));
    }
  }
}

/**
 * Runs an agent step's tries: one, and a second when the first's output was checked and found wanting, unless the step
 * says `fail`. It takes up where the step's earlier tries left it, at `site`: a one-step call's, or a step's of a
 * multi-step call, whose bindings `supplied` holds.
 */
export async function runAgentTries(
  request: CallRequest,
  definition: AgentStep,
  agent: AgentExecution,
  site: TrySite,
  supplied: Readonly<Record<string, Supplied>>,
): Promise<Ran> {
  const { runDir, runId, call } = request;
  const stage = request.definition.name;
  const { key } = site;
  const emit: CallEmit = (event) => request.emit?.({ ...event, key } as NewEvent);
  const clock = request.clock ?? systemClock;
  const corrects = (definition.onInvalidOutput ?? 'retry-once') === 'retry-once';
  const tries = priorTries(runDir, site);
  // A call with nowhere to emit has no events to set right.
  if (tries.length > 0 && request.emit !== undefined) reconcile(runDir, site, tries, emit);

  /** The problems of the try whose output was checked and found wanting, which the next try is told. */
  let found: ContractError[] | undefined;
  for (const prior of tries) {
    if (prior.result === undefined || !failedValidation(prior.result)) continue;
    // The call has had its last word, and only its journal line is missing: its correction failed too, or it gets none.
    if (prior.result.validationTry === 2 || !corrects) return { result: prior.result, paths: prior.paths };
    found = errorsOf(prior.result);
  }

  // Parsed once for the call: each try gets a `$STAGE_IN` of its own, and the same values.
  const bindings = prepareBindings(definition.consumes, supplied);
  const nextOnDisk = () => (site.tries().at(-1) ?? 0) + 1;
  let tryNumber = Math.max(site.step === undefined ? (request.try ?? 1) : 1, (tries.at(-1)?.try ?? 0) + 1);
  while (true) {
    // Before the try's directory exists, so a try that crashes creating it still shows it started.
    emit(site.start(tryNumber));
    const paths = site.paths(tryNumber);
    createCallDir(paths, { durable: true });
    const { inputs, consumed } = materialisePrepared(bindings, paths.stageIn);
    for (const [binding, from] of Object.entries(consumed)) {
      if (from !== null) emit({ type: 'input:materialised', binding, from });
    }
    const startedAt = clock();
    const ran = await KINDS.agent.run(definition, {
      runId,
      runDir,
      stage,
      call,
      key,
      try: tryNumber,
      stageDir: dirname(request.stageFile),
      workspace: request.workspace,
      root: request.root,
      branch: request.branch,
      config: request.config,
      paths,
      inputs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      emit,
      clock,
      agent: {
        harness: agent.harness,
        model: agent.model,
        bindings,
        ...(agent.conventions === undefined ? {} : { conventions: agent.conventions }),
        validationTry: found === undefined ? 1 : 2,
        ...(found === undefined ? {} : { feedback: found.map((error) => error.message) }),
      },
    });
    const finishedAt = clock();
    // No corrective try starts once the call is aborted: the try keeps its place, and a resume corrects it.
    const corrected =
      corrects && found === undefined && ran.record.validationFailed === true && request.signal?.aborted !== true;
    // A try that is corrected says what it got wrong. The call's last try also says what it was correcting.
    const errors = corrected ? ran.errors : distinct([...(found ?? []), ...ran.errors]);
    const run: StepRun = ran.outcome === 'error' ? { ...ran, errors } : ran;
    const result = buildResult({
      runId,
      stage,
      call,
      ...(site.step === undefined ? {} : { step: site.step }),
      kind: 'agent',
      run,
      consumed,
      startedAt,
      finishedAt,
    });
    // On disk, whole and synced, before another session starts: it is what a resume reads the call's place from.
    writeResult(paths.result, result, { durable: true });
    emit(site.end(tryNumber, result, runRelative(runDir, paths.result)));
    // Checked again now that the try has ended: whoever heard its end may have aborted the call.
    if (!corrected || request.signal?.aborted === true) return { result, paths };
    found = ran.errors;
    // From disk, not the try after this one: a session may have left a directory of that name in its `$STAGE_OUT`.
    tryNumber = nextOnDisk();
  }
}
