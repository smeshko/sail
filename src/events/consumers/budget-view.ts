// What the terminal view draws of a run's budget: the final block's `cost` row, and the lines of the run's own budget
// events, a warning, an exceeded budget and a raise. A step's own budget events carry their call's key, and aren't
// drawn here. Dollars print as `sail show` prints them, to the cent, without importing the CLI.
import type { SailEvent } from '../types';

type EventOf<T extends SailEvent['type']> = Extract<SailEvent, { type: T }>;

const usd = (value: number): string => `$${value.toFixed(2)}`;
const minutes = (value: number): string => String(Math.round(value * 100) / 100);

/** What was used of a budget against its limit: `$0.41 of $0.50`, `72 of 90 min`. */
const against = (budget: 'turns' | 'usd' | 'minutes', used: number, limit: number): string =>
  budget === 'usd'
    ? `${usd(used)} of ${usd(limit)}`
    : `${minutes(used)} of ${minutes(limit)}${budget === 'minutes' ? ' min' : ''}`;

/** A run-level `budget:warning` or `budget:exceeded`: `budget usd at $0.41 of $0.50`, `budget usd exceeded: …`. */
export function budgetText(event: EventOf<'budget:warning'> | EventOf<'budget:exceeded'>): string {
  const used = against(event.budget, event.used, event.limit);
  return event.type === 'budget:warning'
    ? `budget ${event.budget} at ${used}`
    : `budget ${event.budget} exceeded: ${used}`;
}

/** A `budget:raised`: `budget raised by $5: now $5.50`, or by minutes, or both. */
export function raisedText(event: EventOf<'budget:raised'>): string {
  const by: string[] = [];
  const now: string[] = [];
  if (event.usd !== undefined) by.push(`$${event.usd}`);
  if (event.minutes !== undefined) by.push(`${minutes(event.minutes)} min`);
  if (event.budget.maxUsd !== undefined && event.usd !== undefined) now.push(usd(event.budget.maxUsd));
  if (event.budget.maxMinutes !== undefined && event.minutes !== undefined)
    now.push(`${minutes(event.budget.maxMinutes)} min`);
  return `budget raised by ${by.join(' and ')}: now ${now.join(' and ')}`;
}

export interface BudgetView {
  /** Folds the run's dollar budget, its raises and what its sessions spent. */
  update(event: SailEvent): void;
  /** The final block's `cost` row, or undefined while the run has used nothing. */
  costRow(): [string, string] | undefined;
}

export function createBudgetView(): BudgetView {
  let maxUsd: number | undefined;
  let spent = 0;
  let used = false;
  return {
    update(event) {
      if (event.type === 'run:start') maxUsd = event.budget?.maxUsd;
      else if (event.type === 'budget:raised') maxUsd = event.budget.maxUsd ?? maxUsd;
      else if (event.type === 'harness:session_end') {
        spent += event.usage.costUsd;
        used = true;
      }
    },
    costRow() {
      if (!used) return undefined;
      const total = Math.round(spent * 1e6) / 1e6;
      if (maxUsd === undefined) return ['cost', usd(total)];
      const pct = maxUsd > 0 ? Math.round((total / maxUsd) * 1000) / 10 : 0;
      return ['cost', `${usd(total)} of ${usd(maxUsd)} (${pct}%)`];
    },
  };
}
