// result.json: the engine's record of one call, built from how its step ran and validated before it is written.
import type { StepRun } from '../kinds/index';
import type { Usage } from '../ports/types';
import { writeOwnFile } from './call-dir';
import type { ContractError } from './contract';
import { replaceFileAnew } from './durable';
import type { Redactor } from './redact';
import { formatIssue, validateDocument } from './schemas';

export interface ResultFields {
  runId: string;
  stage: string;
  call: number;
  /** The step of a multi-step call the result is for: its key is then `<stage>#<call>/<step>`. */
  step?: string;
  kind: string;
  run: StepRun;
  consumed: Record<string, string | null>;
  startedAt: Date;
  finishedAt: Date;
}

/** The call's `result.json`: the call, its outcome and why it is `error` if it is, then timing and the kind's fields. */
export function buildResult(fields: ResultFields): Record<string, unknown> {
  const { run } = fields;
  return {
    schema: 'sail.result.v1',
    runId: fields.runId,
    stage: fields.stage,
    call: fields.call,
    ...(fields.step === undefined ? {} : { step: fields.step }),
    key: `${fields.stage}#${fields.call}${fields.step === undefined ? '' : `/${fields.step}`}`,
    kind: fields.kind,
    outcome: run.outcome,
    ...(run.outcome === 'error' ? { errors: run.errors } : {}),
    output: run.output,
    files: run.files,
    consumed: fields.consumed,
    startedAt: fields.startedAt.toISOString(),
    finishedAt: fields.finishedAt.toISOString(),
    durationMs: fields.finishedAt.getTime() - fields.startedAt.getTime(),
    ...run.record,
  };
}

/** One step of a multi-step call, as its stage's result lists it: its own result, and where that is. */
export interface StepEntry {
  step: string;
  kind: 'agent' | 'script';
  result: Record<string, unknown>;
  /** Relative to the run directory. */
  resultPath: string;
}

const ZERO: Usage = { costUsd: 0 };

/** Two usages added up: a token count only one of them has is taken as it is. */
function plus(a: Usage, b: Usage): Usage {
  const sum: Usage = { costUsd: a.costUsd + b.costUsd };
  for (const field of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const) {
    if (a[field] !== undefined || b[field] !== undefined) sum[field] = (a[field] ?? 0) + (b[field] ?? 0);
  }
  return sum;
}

/**
 * A multi-step call's `result.json`, from the steps that ran, in order: the last of them ended the stage (D2). Its
 * outcome is that step's, and so are its reason when blocked and its errors when error. Its output is that step's
 * unless it was blocked or broke its contract, its files are every step's, and its times and usage are the steps' (D8).
 * Stage-level `errors`, such as a step's file gone by the stage's end, make the outcome `error` whatever the last
 * step's was, with no output and no reason: its own errors, when it ended `error`, then these.
 */
export function buildStageResult(fields: {
  runId: string;
  stage: string;
  call: number;
  consumed: Record<string, string | null>;
  steps: readonly StepEntry[];
  errors?: readonly ContractError[];
}): Record<string, unknown> {
  const last = fields.steps.at(-1);
  if (last === undefined) throw new Error(`${fields.stage}#${fields.call}: a stage's result needs a step that ran`);
  const { result } = last;
  const stageErrors = fields.errors ?? [];
  const outcome = stageErrors.length > 0 ? 'error' : result.outcome;
  const errors = [...(result.outcome === 'error' ? (result.errors as ContractError[]) : []), ...stageErrors];
  const usageOf = (step: StepEntry) => (step.result.usage as Usage | undefined) ?? ZERO;
  return {
    schema: 'sail.result.v1',
    runId: fields.runId,
    stage: fields.stage,
    call: fields.call,
    key: `${fields.stage}#${fields.call}`,
    outcome,
    ...(outcome === 'error' ? { errors } : {}),
    ...(outcome === 'blocked' ? { reason: result.reason } : {}),
    output: outcome === 'blocked' || outcome === 'error' ? null : result.output,
    // Entries, not assignment: a file named `__proto__` would set the prototype.
    files: Object.fromEntries(fields.steps.flatMap((step) => Object.entries(step.result.files as object))),
    consumed: fields.consumed,
    steps: fields.steps.map((step) => ({
      step: step.step,
      kind: step.kind,
      outcome: step.result.outcome,
      resultPath: step.resultPath,
      ...(step.kind === 'agent' ? { costUsd: usageOf(step).costUsd } : {}),
    })),
    usage: fields.steps.map(usageOf).reduce(plus, ZERO),
    startedAt: fields.steps[0]?.result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: fields.steps.reduce((sum, step) => sum + Number(step.result.durationMs ?? 0), 0),
  };
}

/**
 * Writes `result` to `path` once it validates against `sail.result.v1`. One that doesn't is a bug in sail, and throws.
 * A `durable` result is written whole and synced before this returns: a resume reads how far an agent call got from it.
 */
export function writeResult(
  path: string,
  result: Record<string, unknown>,
  options: { durable?: boolean; redact?: Redactor } = {},
): void {
  result = options.redact?.value(result) ?? result;
  const issues = validateDocument('sail.result.v1', result);
  if (issues.length > 0) {
    throw new Error(`result.json breaks sail.result.v1, a bug in sail:\n${issues.map(formatIssue).join('\n')}`);
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  // Either way a new file: the call directory is where the step wrote, and may hold a link under the result's name.
  if (options.durable) replaceFileAnew(path, text);
  else writeOwnFile(path, text);
}
