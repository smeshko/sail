// A run's budget: the most one run may use, in dollars and in minutes, and what it has used of it.
//
// TDD stub (run-budgets-and-suspension): every symbol with its final signature and a wrong value. A run keeps its
// header's budget as project.yaml gave it, and has no tracker, so it runs as before.
import type { NewEvent, SailEvent } from '../events/types';
import type { Harness } from '../ports/harness';
import type { RunHeader } from './run-header';

/** The most one run may use: dollars, minutes, or both. */
export type RunBudget = NonNullable<RunHeader['budget']>;

/** The share of a budget at which its warning fires. */
export const WARN_AT = 0.8;

/** `workflow`'s budget over `project`'s, field by field. TDD stub: `project`'s alone, as before. */
export function runBudgetOf(project: RunBudget | undefined, _workflow: RunBudget | undefined): RunBudget | undefined {
  return project !== undefined && Object.keys(project).length > 0 ? project : undefined;
}

/** What is wrong with a workflow's `budget`. TDD stub: nothing. */
export function workflowBudgetProblem(_value: unknown): string | undefined {
  return undefined;
}

/** What a run has used: dollars, and minutes of active time. */
export interface RunUsed {
  usd: number;
  minutes: number;
}

/** A budget the run has used up: which, its limit and what was used. */
export interface Over {
  budget: 'usd' | 'minutes';
  limit: number;
  used: number;
}

/** What the run whose events these are has used. TDD stub: nothing. */
export function usedOf(_events: readonly SailEvent[]): RunUsed {
  return { usd: 0, minutes: 0 };
}

/** The run's budget now, with the last raise over it. TDD stub: the header's. */
export function budgetAfterRaises(budget: RunBudget | undefined, _events: readonly SailEvent[]): RunBudget | undefined {
  return budget;
}

/** What a raise adds: dollars, minutes, or both. */
export interface Raise {
  usd?: number;
  minutes?: number;
}

/** The flag that raises a budget. TDD stub: none. */
export const raiseFlag = (_budget: Over['budget']): string => '';

/** A run suspended on its budget before `before`. TDD stub: an empty one. */
export function suspension(_over: Over, _before: string): { event: NewEvent; message: string } {
  return {
    event: { type: 'run:suspended', stopReason: 'budget_exceeded', budget: 'usd', limit: 0, used: 0 },
    message: '',
  };
}

/** Why run `runId` can't resume with `raise`. TDD stub: it always can. */
export function raiseProblem(
  _runId: string,
  _budget: RunBudget | undefined,
  _events: readonly SailEvent[],
  _raise: Raise = {},
): string | undefined {
  return undefined;
}

export interface BudgetOptions {
  /** The run's budget, from its header. */
  budget: RunBudget | undefined;
  /** The run's events when its drive loop starts: none for a fresh run. */
  prior: readonly SailEvent[];
  /** Emits the run's own budget events, and returns each stamped. */
  emit: (event: NewEvent) => SailEvent;
  /** Confirms `event` reached the disk, or throws. */
  record: (event: SailEvent) => void;
  /** Monotonic milliseconds: this process's active time is read from it. */
  elapsed: () => number;
}

export interface BudgetTracker {
  /** Folds one of the run's events, confirms a session's end on disk, and emits what has come due. */
  observe(event: SailEvent): void;
  /** The budget the run has used up, dollars first, or undefined while it has some left. Emits what has come due. */
  over(): Over | undefined;
  /** Throws the failure to confirm a session's end on disk, if one came. */
  assertRecorded(): void;
  /**
   * Whether the last request under `key` was handed less than its step's own budget: in the budget its session said it
   * exceeded, when it said which, or else in either.
   */
  narrowed(key: string): boolean;
  /** `inner`, handing each request its share of what the run has left. */
  harness(inner: Harness): Harness;
  /** Adds `raise` to the budget, emits it as `budget:raised`, and confirms it on disk: a failure throws. */
  raise(raise: Raise): void;
}

/** The tracker of a run's budget. TDD stub: none, for any run. */
export function trackBudget(_options: BudgetOptions): BudgetTracker | undefined {
  return undefined;
}

/** Confirms an event of the run in `runDir` reached the disk. TDD stub: confirms nothing. */
export function recordIn(_runDir: string): (event: SailEvent) => void {
  return () => {};
}
