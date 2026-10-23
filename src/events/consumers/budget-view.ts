// What the terminal view draws of a run's budget.
//
// TDD stub (run-budgets-and-suspension): every symbol with its final signature and a wrong value.
import type { SailEvent } from '../types';

type EventOf<T extends SailEvent['type']> = Extract<SailEvent, { type: T }>;

/** A run-level `budget:warning` or `budget:exceeded`. TDD stub: no text. */
export function budgetText(_event: EventOf<'budget:warning'> | EventOf<'budget:exceeded'>): string {
  return '';
}

/** A `budget:raised`. TDD stub: no text. */
export function raisedText(_event: EventOf<'budget:raised'>): string {
  return '';
}

export interface BudgetView {
  /** Folds the run's dollar budget, its raises and what its sessions spent. */
  update(event: SailEvent): void;
  /** The final block's `cost` row, or undefined while the run has used nothing. */
  costRow(): [string, string] | undefined;
}

/** TDD stub: folds nothing, and has no row. */
export function createBudgetView(): BudgetView {
  return { update: () => {}, costRow: () => undefined };
}
