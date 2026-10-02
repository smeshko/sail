// The Harness port: runs an agent step's session, with permissions, a budget and a schema to submit against. It speaks
// sail's own events, and the agent kind stamps each one with the call's key. It never rejects: every failure, an abort
// included, is the `error` outcome (ADR-0008).
import type { CallEvent } from '../events/types';
import type { Budget, HarnessCapabilities, HarnessResult, Permissions } from './types';

type HarnessEventType =
  | 'harness:session_start'
  | 'harness:session_end'
  | 'agent:message'
  | 'agent:thinking'
  | 'tool:start'
  | 'tool:end'
  | 'permission:denied'
  | 'usage:update'
  | 'budget:warning'
  | 'budget:exceeded'
  | 'error:harness';

/** An event a harness emits, without the key: the agent kind stamps it. */
export type HarnessEvent = Extract<CallEvent, { type: HarnessEventType }>;

export interface HarnessRequest {
  /** The call's key, such as `spec#1` or `publish#1/describe`. */
  readonly key: string;
  readonly try: number;
  readonly prompt: string;
  readonly cwd: string;
  /** The call's preamble: `STAGE_IN`, `STAGE_OUT` and `INPUT_*`. */
  readonly env: Readonly<Record<string, string>>;
  readonly model: string;
  readonly permissions: Permissions;
  readonly budget: Budget;
  /** The JSON Schema the agent submits its output against. */
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: HarnessEvent) => void;
}

export interface Harness {
  readonly name: string;
  /** Never rejects. */
  run(request: HarnessRequest): Promise<HarnessResult>;
  capabilities(): HarnessCapabilities;
}
