// result.json: the engine's record of one call, built from how its step ran and validated before it is written.
import { writeFileSync } from 'node:fs';
import type { StepRun } from '../kinds/index';
import { formatIssue, validateDocument } from './schemas';

export interface ResultFields {
  runId: string;
  stage: string;
  call: number;
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
    key: `${fields.stage}#${fields.call}`,
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

/** Writes `result` to `path` once it validates against `sail.result.v1`. One that doesn't is a bug in sail, and throws. */
export function writeResult(path: string, result: Record<string, unknown>): void {
  const issues = validateDocument('sail.result.v1', result);
  if (issues.length > 0) {
    throw new Error(`result.json breaks sail.result.v1, a bug in sail:\n${issues.map(formatIssue).join('\n')}`);
  }
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
}
