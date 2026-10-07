// One try of a built-in intake: the call the engine makes before any workflow code (ADR-0009). The body runs in
// process, into `00-intake/call-1/`, and the try is recorded like a step's: its output checked against the intake's
// schema, its declared files recorded, `result.json` written, `intake:start` and `intake:end` around it. The runtime
// journals it and decides what its outcome means for the run.
//
// The call records the kind `builtin`: no step ran, so it has no exit, command or logs, and no `in/`, since the body
// reads the source from the run header.
import { BUILTIN_INTAKES, type IntakeBody } from '../builtins/intakes/index';
import type { Emit } from '../events/types';
import type { StepRun } from '../kinds/index';
import { PortError } from '../ports/errors';
import type { TicketSource } from '../ports/ticket-source';
import { type CallPaths, callPaths, createCallDir, runRelative } from './call-dir';
import { type ContractError, recordFiles, validateOutput } from './contract';
import type { LoadedIntake } from './load-workflow';
import { buildResult, writeResult } from './result';
import type { Source } from './run-dir';

/** The intake's stage name: its call directory is `00-intake/`, and no stage may take the name. */
export const INTAKE_STAGE = 'intake';
/** The stage index of the intake's directory. The workflow's stages count from 1. */
export const INTAKE_INDEX = 0;
/** The key an intake is journaled under: its one call. */
export const INTAKE_KEY = `${INTAKE_STAGE}#1`;

/** Where the body's one input came from, as `consumed` records it. */
const CONSUMED = { source: 'run.json#/source' };

export interface IntakeRequest {
  /** The absolute run directory. */
  runDir: string;
  runId: string;
  intake: LoadedIntake;
  body: IntakeBody;
  source: Source;
  ticketSource: TicketSource;
  /** 1 unless an earlier try was interrupted. */
  try?: number;
  signal?: AbortSignal;
  emit?: Emit;
}

export interface RanIntake {
  /** The try's `result.json`, as written. */
  result: Record<string, unknown>;
  paths: CallPaths;
}

/** The body of a built-in intake, or undefined for an intake the repository exports: only a built-in runs. */
export function intakeBody(loaded: LoadedIntake): IntakeBody | undefined {
  return BUILTIN_INTAKES.get(loaded.definition);
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `value` as the intake's schema parses it, or why it isn't the run's input: the schema refuses it, or JSON can't hold it. */
function checkOutput(
  intake: LoadedIntake,
  value: unknown,
): { ok: true; data: unknown } | { ok: false; message: string } {
  const checked = validateOutput(intake.definition.output, value);
  if (!checked.ok) return { ok: false, message: `the output doesn't match its schema:\n${checked.message}` };
  try {
    // The result and the journal hold the output as JSON, and the workflow reads it back from there.
    if (JSON.stringify(checked.data) === undefined)
      return { ok: false, message: "the output can't be written as JSON" };
  } catch (error) {
    return { ok: false, message: `the output can't be written as JSON: ${messageOf(error)}` };
  }
  return checked;
}

/** What a body that returned left: its output checked, its declared files recorded, and each problem an error. */
function recordTry(intake: LoadedIntake, returned: unknown, out: string, runDir: string, emit: Emit): StepRun {
  const key = INTAKE_KEY;
  const errors: ContractError[] = [];
  const output = checkOutput(intake, returned);
  if (output.ok) emit({ type: 'output:validated', key });
  else {
    emit({ type: 'output:invalid', key, message: output.message });
    errors.push({ reason: 'invalid_output', message: output.message });
  }
  const produced = recordFiles(intake.definition.produces, out, runDir);
  for (const [name, { path, bytes, sha256 }] of Object.entries(produced.files)) {
    emit({ type: 'file:produced', key, name, path, bytes, sha256 });
  }
  errors.push(...produced.errors);
  return {
    outcome: errors.length > 0 ? 'error' : 'passed',
    output: errors.length > 0 || !output.ok ? null : output.data,
    files: produced.files,
    errors,
    record: {},
  };
}

/** Runs one try of a built-in intake and records it. A body that throws anything but a PortError rejects. */
export async function runIntake(request: IntakeRequest): Promise<RanIntake> {
  const { runDir, runId, intake } = request;
  const emit: Emit = request.emit ?? (() => {});
  const key = INTAKE_KEY;
  // Before the call directory exists, so a try that crashes creating it still shows it started.
  emit({
    type: 'intake:start',
    key,
    intake: intake.definition.name,
    kind: 'builtin',
    origin: 'builtin',
    consumed: CONSUMED,
  });
  const paths = callPaths(runDir, INTAKE_INDEX, INTAKE_STAGE, 1, request.try ?? 1);
  createCallDir(paths, { stageIn: false });

  const startedAt = new Date();
  let returned: unknown;
  let failure: ContractError | undefined;
  try {
    returned = await request.body({
      source: request.source,
      ticketSource: request.ticketSource,
      out: paths.dir,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (error) {
    // A port that failed is the intake's outcome. Anything else the body throws is a bug in sail.
    if (!(error instanceof PortError)) throw error;
    failure = { reason: 'port', message: `${error.message} (${error.code})` };
  }
  const run: StepRun =
    failure === undefined
      ? recordTry(intake, returned, paths.dir, runDir, emit)
      : { outcome: 'error', output: null, files: {}, errors: [failure], record: {} };
  const finishedAt = new Date();

  const result = buildResult({
    runId,
    stage: INTAKE_STAGE,
    call: 1,
    kind: 'builtin',
    run,
    consumed: CONSUMED,
    startedAt,
    finishedAt,
  });
  writeResult(paths.result, result);
  emit({
    type: 'intake:end',
    key,
    outcome: run.outcome === 'passed' ? 'passed' : 'error',
    resultPath: runRelative(runDir, paths.result),
  });
  return { result, paths };
}
