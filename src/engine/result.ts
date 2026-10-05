// result.json: the engine's record of one call, built from how its step ran and validated before it is written.
import type { StepRun } from '../kinds/index';
import { writeOwnFile } from './call-dir';
import { replaceFileAnew } from './durable';
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

/**
 * Writes `result` to `path` once it validates against `sail.result.v1`. One that doesn't is a bug in sail, and throws.
 * A `durable` result is written whole and synced before this returns: a resume reads how far an agent call got from it.
 */
export function writeResult(path: string, result: Record<string, unknown>, options: { durable?: boolean } = {}): void {
  const issues = validateDocument('sail.result.v1', result);
  if (issues.length > 0) {
    throw new Error(`result.json breaks sail.result.v1, a bug in sail:\n${issues.map(formatIssue).join('\n')}`);
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  // Either way a new file: the call directory is where the step wrote, and may hold a link under the result's name.
  if (options.durable) replaceFileAnew(path, text);
  else writeOwnFile(path, text);
}
