// STUB (harness-guardrails TASK-005): the final types, and a watch that says nothing and sets no timer.
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessEvent } from '../../ports/harness';
import type { Budget } from '../../ports/types';

/** Where a budget's warning comes. */
export const WARN_AT = 0.8;

/** The timers the minute budget runs on: the system's, or a test's (D14). */
export interface BudgetTimers {
  set(fn: () => unknown, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface BudgetWatchOptions {
  readonly budget: Budget;
  readonly timers: BudgetTimers;
  /** Milliseconds, for the minutes used. */
  readonly now: () => number;
  readonly emit: (event: HarnessEvent) => void;
  /** Called once the minute budget is used up, after its `budget:exceeded`. */
  readonly onOverMinutes: () => void;
}

export interface BudgetWatch {
  /** `n` turns have closed. */
  turn(n: number): void;
  /** Starts the minute budget's timers. */
  start(): void;
  /** Clears whatever timer is still set. */
  stop(): void;
  /** The session's result: the dollar warning, and a turn or dollar overrun. */
  result(result: SDKResultMessage): void;
}

/** STUB: watches nothing. */
export function createBudgetWatch(_options: BudgetWatchOptions): BudgetWatch {
  return { turn: () => undefined, start: () => undefined, stop: () => undefined, result: () => undefined };
}
