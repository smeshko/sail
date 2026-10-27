// A multi-step stage's call: its steps in order, sharing the call's `$STAGE_OUT` (D1). `call.ts` runs each step's
// tries; this module sequences them, gives each step the bindings it declares, and writes the stage's `result.json`.
//
// Each step gets a `$STAGE_IN` of its own, holding only its own bindings (D6). A binding the workflow supplies comes
// from the stage's, under the same name. A `fromStep()` binding is what an earlier step left: its output, a field of
// it, or a file it produced. Those values come from the earlier step's result in memory, or from its journal line on a
// resume, and never from its `result.json`: that sits in `$STAGE_OUT`, where any later session may write. A `gitDiff()`
// is taken just before its step starts, so it sees what the steps before it committed.
//
// A step that doesn't pass ends the stage with its outcome, and no later step starts (D2): `steps[]` lists the steps
// that ran. The last step records the stage's own `produces` beside its own (D9). An abort stops at the step it
// reaches (D11): seen between steps, no further step starts and no stage `result.json` is written; seen during a step,
// that try's result is written, and the step is left for a resume to run again.
//
// The caller journals: it hands the call the steps already journaled, which are skipped, and hears of each step as it
// finishes. The runtime journals them, and `sail stage run`, which has no journal, passes nothing.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import type { CallEvent, NewEvent } from '../events/types';
import type { FromStepBinding } from '../sdk/bindings';
import type { AgentStep, ScriptStep, Stage, Step } from '../sdk/steps';
import { collisionProblems, type Supplied } from './bindings';
import {
  type AgentExecution,
  type CallRequest,
  type Ran,
  runAgentTries,
  runScriptTry,
  type TrySite,
  withStageProduces,
} from './call';
import {
  type CallPaths,
  callPaths,
  createCallDir,
  existingStepTries,
  nextStepTry,
  runRelative,
  stageOut,
  stepPaths,
} from './call-dir';
import { type ContractError, recordFiles } from './contract';
import type { JournalEntry } from './journal';
import { buildResult, buildStageResult, type StepEntry, writeResult } from './result';
import { checkoutPath } from './run-dir';
import { validateDocument } from './schemas';
import { type Def, WRAPPERS } from './untrusted';

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

/** A step a call has done: its key's step, what it ran as, and what the steps after it may read of it. */
interface Done {
  step: Step;
  index: number;
  outcome: string;
  output: unknown;
  /** Each produced file's run-relative path, by name. */
  files: Record<string, string>;
  /** The step's `result.json`, relative to the run directory. */
  resultPath: string;
  /** Its result, as written now or read back for the stage's own: never what a later step reads. */
  result: Record<string, unknown>;
}

const PASSED = new Set(['done', 'passed']);
const NAME = /^[a-z0-9-]+$/;

/** `binds 'title' to fromStep('describe')`, then what it picks. */
const picks = (key: string, binding: FromStepBinding) => `binds '${key}' to fromStep('${binding.step}')`;

const NEVER_OBJECTS = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'symbol',
  'literal',
  'enum',
  'template_literal',
  'date',
  'nan',
  'null',
  'undefined',
  'void',
  'never',
]);
const NULLISH = new Set(['null', 'undefined', 'void']);

/** Whether a schema's value has `key`: `'unknown'` where its shape can't be told at load, which is never refused. */
function outputKey(schema: z.ZodType, key: string, seen = new Set<z.ZodType>()): 'has' | 'lacks' | 'unknown' {
  if (seen.has(schema)) return 'unknown';
  const def = schema.def as Def;
  if (def.type === 'object') return Object.hasOwn(def.shape as object, key) ? 'has' : 'lacks';
  if (WRAPPERS.includes(def.type) && def.innerType) return outputKey(def.innerType, key, seen);
  if (def.type === 'pipe' && def.out) return outputKey(def.out, key, seen);
  if (def.type === 'lazy' && def.getter) return outputKey(def.getter(), key, new Set(seen).add(schema));
  if (def.type === 'union' && def.options) {
    const answers = def.options
      .filter((member) => !NULLISH.has((member.def as Def).type))
      .map((member) => outputKey(member, key, seen));
    if (answers.includes('lacks') || answers.length === 0) return 'lacks';
    return answers.includes('unknown') ? 'unknown' : 'has';
  }
  if (def.type === 'intersection' && def.left && def.right) {
    const answers = [outputKey(def.left, key, seen), outputKey(def.right, key, seen)];
    if (answers.includes('has')) return 'has';
    return answers.includes('unknown') ? 'unknown' : 'lacks';
  }
  return NEVER_OBJECTS.has(def.type) ? 'lacks' : 'unknown';
}

/**
 * What is wrong with how a multi-step stage wires its steps, one message each, naming the stage, the step and the
 * binding (D4, D19). The types catch a misnamed `fromStep()`, and these are erased at run time, so loading checks it
 * again, with what the types can't see: a file the named step doesn't produce, an output key its schema has no field
 * for (read through wrappers, pipes and every member of a union), two steps of one name or one producing what another
 * does, and an engine binding on the stage itself.
 */
export function stepProblems(stage: Stage): string[] {
  const at = `stage '${stage.name}'`;
  const found: string[] = [];
  for (const [key, binding] of Object.entries(stage.consumes)) {
    if (binding.kind === 'gitDiff' || binding.kind === 'fromStep') {
      found.push(`${at}: '${key}' is a ${binding.kind} binding of the stage itself, which only a step can take`);
    }
  }
  const seen = new Set<string>();
  const producer = new Map<string, string>();
  stage.steps.forEach((step, index) => {
    if (!NAME.test(step.name)) found.push(`${at}: step '${step.name}' has a name outside [a-z0-9-]+`);
    if (seen.has(step.name)) found.push(`${at}: two steps are named '${step.name}'`);
    seen.add(step.name);
    for (const name of Object.keys(step.produces)) {
      const first = producer.get(name);
      if (first === undefined) producer.set(name, step.name);
      else found.push(`${at}: steps '${first}' and '${step.name}' both produce '${name}'`);
    }
    // A step's own $STAGE_IN is materialised only as it starts: what would collide there is refused now.
    for (const problem of collisionProblems(step.consumes)) found.push(`${at}: step '${step.name}': ${problem}`);
    for (const [key, binding] of Object.entries(step.consumes)) {
      if (binding.kind !== 'fromStep') continue;
      const named = stage.steps.findIndex((each) => each.name === binding.step);
      const of = `${at}: step '${step.name}' ${picks(key, binding)}`;
      if (named < 0) found.push(`${of}, which names no step of the stage`);
      else if (named === index) found.push(`${of}, its own step`);
      else if (named > index) found.push(`${of}, a step that runs after it`);
      else {
        const source = stage.steps[named] as Step;
        if (binding.file !== undefined && !Object.hasOwn(source.produces, binding.file)) {
          found.push(`${of}'s file '${binding.file}', which it doesn't produce`);
        }
        if (binding.key !== undefined && outputKey(source.output, binding.key) === 'lacks') {
          found.push(`${of}'s output key '${binding.key}', which its output doesn't have`);
        }
      }
    }
  });
  return found;
}

/** Why a value can't be handed on: a required binding left unbound, or a diff that can't be taken. */
class NotStarted {
  constructor(readonly message: string) {}
}

/**
 * The bindings step `index` is supplied with: the stage's under the same names, the earlier steps' outputs and files
 * for its `fromStep()`s, and its `gitDiff()`s taken now. A required one with nothing to bind is why it can't start.
 */
async function suppliedFor(
  request: CallRequest,
  step: Step,
  done: readonly Done[],
  hooks: StageHooks,
): Promise<Record<string, Supplied> | NotStarted> {
  const supplied: [string, Supplied][] = [];
  for (const [key, binding] of Object.entries(step.consumes)) {
    if (binding.kind === 'file' || binding.kind === 'value') {
      const given = Object.hasOwn(request.supplied, key) ? request.supplied[key] : undefined;
      if (given !== undefined) supplied.push([key, given]);
      continue;
    }
    if (binding.kind === 'gitDiff') {
      if (hooks.diff === undefined) return new NotStarted(`'${key}': gitDiff(${binding.range}) can't be taken here`);
      try {
        supplied.push([
          key,
          { kind: 'gitDiff', patch: await hooks.diff(binding.range), from: `gitDiff(${binding.range})` },
        ]);
      } catch (error) {
        return new NotStarted(`'${key}': gitDiff(${binding.range}) failed: ${(error as Error).message}`);
      }
      continue;
    }
    const source = done.find((each) => each.step.name === binding.step);
    const value = source === undefined ? undefined : pick(request.runDir, source, binding);
    if (value !== undefined) supplied.push([key, value]);
    else if (!binding.isOptional) {
      return new NotStarted(`'${key}': ${picks(key, binding).slice(`binds '${key}' to `.length)} has nothing to give`);
    }
  }
  return Object.fromEntries(supplied);
}

/** What a `fromStep()` binding takes from a step that ran, or undefined when it has nothing there. */
function pick(runDir: string, source: Done, binding: FromStepBinding): Supplied | undefined {
  if (binding.file !== undefined) {
    const path = Object.hasOwn(source.files, binding.file) ? source.files[binding.file] : undefined;
    return path === undefined ? undefined : { kind: 'fromStep', path: join(runDir, path), from: path };
  }
  const output = source.output;
  if (binding.key === undefined) return { kind: 'fromStep', value: output, from: `${source.resultPath}#/output` };
  const field =
    typeof output === 'object' && output !== null && Object.hasOwn(output, binding.key)
      ? (output as Record<string, unknown>)[binding.key]
      : undefined;
  return field === undefined
    ? undefined
    : { kind: 'fromStep', value: field, from: `${source.resultPath}#/output/${binding.key}` };
}

/**
 * A step journaled before this process, as the stage's result lists it. The journal line says what later steps read
 * and what the stage records of it: its outcome, output, reason and files, hashed afresh where the journal puts them.
 * Its `result.json`, when it is one, says only what it spent and when it ran, since a later session may have rewritten
 * it. One rewritten past reading is listed with nothing spent and the journal's time.
 */
function journaledStep(request: CallRequest, step: Step, index: number, entry: JournalEntry): Done {
  const path = join(request.runDir, entry.resultPath);
  let read: Record<string, unknown> | undefined;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (validateDocument('sail.result.v1', data).length === 0 && data.key === entry.key) read = data;
  } catch {
    read = undefined;
  }
  const out = stageOut(
    stepPaths(request.runDir, request.stageIndex, request.definition.name, request.call, index, step.name),
  );
  const { reason: _rewritten, ...spent } = read ?? {
    usage: { costUsd: 0 },
    startedAt: entry.recordedAt,
    finishedAt: entry.recordedAt,
    durationMs: 0,
  };
  const produced = Object.fromEntries(Object.keys(entry.files).map((name) => [name, 'file']));
  return {
    step,
    index,
    outcome: entry.outcome,
    output: entry.output,
    files: entry.files,
    resultPath: entry.resultPath,
    result: {
      ...spent,
      outcome: entry.outcome,
      output: entry.output,
      files: recordFiles(produced, out, request.runDir).files,
      ...(entry.outcome === 'blocked' ? { reason: entry.reason } : {}),
    },
  };
}

/** A step that couldn't start: its result, written in the directory of the try it would have run as. */
function unstarted(
  request: CallRequest,
  step: Step,
  index: number,
  why: NotStarted,
): { result: Record<string, unknown>; paths: CallPaths; tryNumber: number } {
  const { runDir, stageIndex, call } = request;
  const stage = request.definition.name;
  const tryNumber = nextStepTry(runDir, stageIndex, stage, call, index, step.name);
  const paths = stepPaths(runDir, stageIndex, stage, call, index, step.name, tryNumber);
  const now = (request.clock ?? (() => new Date()))();
  const errors: ContractError[] = [{ reason: 'not_started', message: why.message }];
  const harness = { adapter: request.agent?.harness.name ?? 'none', model: modelOf(request.agent, step), turns: 0 };
  const record =
    step.kind === 'agent'
      ? {
          try: tryNumber,
          validationTry: 1,
          validationFailed: false,
          harness: { ...harness, toolCalls: 0, denials: 0 },
          usage: { costUsd: 0 },
        }
      : { command: '' };
  const result = buildResult({
    runId: request.runId,
    stage,
    call,
    step: step.name,
    kind: step.kind,
    run: { outcome: 'error', output: null, files: {}, errors, record },
    consumed: Object.fromEntries(Object.keys(step.consumes).map((key) => [key, null])),
    startedAt: now,
    finishedAt: now,
  });
  return { result, paths, tryNumber };
}

/** The model an agent step runs on: the one its stage's execution names for it, or the execution's own. */
const modelOf = (agent: AgentExecution | undefined, step: Step): string =>
  agent?.models?.[step.name] ?? agent?.model ?? '';

/**
 * Runs a multi-step stage's call: its steps in order, from the first that `hooks.finished` doesn't hold, until one
 * doesn't pass or the last does, then writes the stage's `result.json`. Callers check `callProblems` first.
 */
export async function runStageCall(request: CallRequest, stage: Stage, hooks: StageHooks = {}): Promise<Ran> {
  const { runDir, runId, stageIndex, call } = request;
  const name = stage.name;
  const callKey = `${name}#${call}`;
  const emitCall = (event: CallEvent) => request.emit?.({ ...event, key: callKey } as NewEvent);
  const of = stage.steps.length;
  const consumed = Object.fromEntries(
    Object.keys(stage.consumes)
      .filter((key) => Object.hasOwn(request.supplied, key))
      .map((key) => [key, request.supplied[key]?.from ?? null]),
  );
  emitCall({
    type: 'stage:start',
    stage: name,
    call,
    try: 1,
    kind: 'stage',
    steps: stage.steps.map((s) => s.name),
    consumed,
  });

  const done: Done[] = [];
  const finished = hooks.finished ?? [];
  const lastIndex = of;
  for (const [offset, declared] of stage.steps.entries()) {
    const index = offset + 1;
    const step: Step = index === lastIndex ? withStageProduces(declared, stage) : declared;
    const entry = finished[offset];
    if (entry !== undefined) {
      done.push(journaledStep(request, step, index, entry));
      if (!PASSED.has(entry.outcome)) break;
      continue;
    }
    if (request.signal?.aborted) return { result: {}, paths: callPaths(runDir, stageIndex, name, call), stopped: true };

    const key = `${callKey}/${step.name}`;
    const start = (tryNumber: number): CallEvent => ({
      type: 'step:start',
      stage: name,
      step: step.name,
      index,
      of,
      kind: step.kind,
      try: tryNumber,
      ...(step.kind === 'agent'
        ? { model: modelOf(request.agent, step) }
        : { command: checkoutPath(request.root, request.runDir, join(dirname(request.stageFile), step.run)) }),
    });
    const end = (tryNumber: number, result: Record<string, unknown>, resultPath: string): CallEvent => ({
      type: 'step:end',
      step: step.name,
      try: tryNumber,
      outcome: result.outcome as JournalEntry['outcome'],
      resultPath,
      ...(result.outcome === 'error' ? { errors: (result.errors ?? []) as ContractError[] } : {}),
    });
    const emitStep = (event: CallEvent) => request.emit?.({ ...event, key } as NewEvent);

    let ran: Ran;
    const supplied = await suppliedFor(request, step, done, hooks);
    if (supplied instanceof NotStarted) {
      const failed = unstarted(request, step, index, supplied);
      emitStep(start(failed.tryNumber));
      createCallDir(failed.paths);
      writeResult(failed.paths.result, failed.result);
      emitStep(end(failed.tryNumber, failed.result, runRelative(runDir, failed.paths.result)));
      ran = { result: failed.result, paths: failed.paths };
    } else if (step.kind === 'agent') {
      const site: TrySite = {
        key,
        step: step.name,
        paths: (tryNumber) => stepPaths(runDir, stageIndex, name, call, index, step.name, tryNumber),
        tries: () => existingStepTries(runDir, stageIndex, name, call, index, step.name),
        start,
        end,
        starts: 'step:start',
      };
      const agent = request.agent as AgentExecution;
      ran = await runAgentTries(request, step as AgentStep, { ...agent, model: modelOf(agent, step) }, site, supplied);
    } else {
      const tryNumber = nextStepTry(runDir, stageIndex, name, call, index, step.name);
      ran = await runScriptTry(request, step as ScriptStep, supplied, {
        key,
        step: step.name,
        paths: stepPaths(runDir, stageIndex, name, call, index, step.name, tryNumber),
        try: tryNumber,
        start: start(tryNumber),
        end: (result, resultPath) => end(tryNumber, result, resultPath),
      });
    }
    // A step the abort reached is left for a resume to run again: its try's result stays, and nothing else is written.
    if (request.signal?.aborted) return { ...ran, stopped: true };
    if (hooks.onStep?.(ran.result, ran.paths) === false) return { ...ran, stopped: true };
    const files = ran.result.files as Record<string, { path: string }>;
    done.push({
      step,
      index,
      outcome: String(ran.result.outcome),
      output: ran.result.output,
      files: Object.fromEntries(Object.entries(files).map(([file, { path }]) => [file, path])),
      resultPath: runRelative(runDir, ran.paths.result),
      result: ran.result,
    });
    if (!PASSED.has(String(ran.result.outcome))) break;
  }

  const steps: StepEntry[] = done.map((each) => ({
    step: each.step.name,
    kind: each.step.kind,
    result: each.result,
    resultPath: each.resultPath,
  }));
  const result = buildStageResult({ runId, stage: name, call, consumed, steps });
  const paths = callPaths(runDir, stageIndex, name, call);
  writeResult(paths.result, result);
  emitCall({
    type: 'stage:end',
    stage: name,
    call,
    try: 1,
    outcome: result.outcome as JournalEntry['outcome'],
    durationMs: result.durationMs as number,
    resultPath: runRelative(runDir, paths.result),
    ...(result.outcome === 'error' ? { errors: result.errors as ContractError[] } : {}),
  });
  return { result, paths };
}
