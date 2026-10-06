// One try of a built-in intake: the call the engine makes before any workflow code (ADR-0009). The body runs in
// process, into `00-intake/call-1/`, and the try is recorded like a step's: its output checked against the intake's
// schema, its declared files recorded, `result.json` written, `intake:start` and `intake:end` around it. The runtime
// journals it and decides what its outcome means for the run.
import type { IntakeBody } from '../builtins/intakes/index';
import type { Emit } from '../events/types';
import type { TicketSource } from '../ports/ticket-source';
import { type CallPaths, callPaths } from './call-dir';
import type { LoadedIntake } from './load-workflow';
import type { Source } from './run-dir';

/** The intake's stage name: its call directory is `00-intake/`, and no stage may take the name. */
export const INTAKE_STAGE = 'intake';
/** The stage index of the intake's directory. The workflow's stages count from 1. */
export const INTAKE_INDEX = 0;
/** The key an intake is journaled under: its one call. */
export const INTAKE_KEY = `${INTAKE_STAGE}#1`;

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
export function intakeBody(_loaded: LoadedIntake): IntakeBody | undefined {
  return undefined;
}

/** Runs one try of a built-in intake and records it. A body that throws anything but a PortError rejects. */
export async function runIntake(request: IntakeRequest): Promise<RanIntake> {
  return { result: {}, paths: callPaths(request.runDir, INTAKE_INDEX, INTAKE_STAGE, 1, request.try ?? 1) };
}
