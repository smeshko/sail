// Step kinds: how the engine runs a step of one kind and checks its contract. `StepKind` is the extension point, and
// the script kind is its first implementation. Epic 05 adds `agent`.
import type { CallPaths } from '../engine/call-dir';
import type { ContractError, FileEntry } from '../engine/contract';
import type { CallEmit } from '../events/types';
import type { Step } from '../sdk/steps';
import { scriptKind } from './script';

/** Everything a kind needs to run one step of one call. Paths are absolute. */
export interface StepContext {
  runId: string;
  runDir: string;
  stage: string;
  call: number;
  /** The call's try, 1 unless an earlier try was interrupted. */
  try: number;
  /** The directory of the `stage.ts` that declared the step: its `run` and `prompt` are relative to it. */
  stageDir: string;
  workspace: string;
  /** `project.yaml`. */
  config: string;
  paths: CallPaths;
  /** The `INPUT_<NAME>` variables, pointing into `$STAGE_IN`. */
  inputs: Record<string, string>;
  signal?: AbortSignal;
  /** Between SIGTERM and SIGKILL when the step is stopped. */
  graceMs?: number;
  /** Where the step's events go. The call stamps each with its key. */
  emit?: CallEmit;
}

/** How a step ended. `record` holds the kind's own `result.json` fields, such as a script's `exit`, `command` and `env`. */
export interface StepRun {
  outcome: string;
  output: unknown;
  files: Record<string, FileEntry>;
  /** Every contract problem found. Non-empty exactly when the outcome is `error`. */
  errors: ContractError[];
  record: Record<string, unknown>;
}

export interface StepKind<S extends Step> {
  readonly kind: S['kind'];
  /** What is wrong with the step's declaration itself, found before anything runs. */
  problems(step: S): string[];
  run(step: S, context: StepContext): Promise<StepRun>;
}

/** Every step kind the engine runs, by `kind`. */
export const KINDS = { script: scriptKind };
