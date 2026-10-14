// A session's three budgets, watched (D13): `budget:warning` once when what is used first reaches 80% of a budget, and
// `budget:exceeded` once when it is used up. Turns are counted as each one closes and dollars are known only at the
// result (7.2 D3); the minute budget is a timer of its own, which ends the session when it runs out (D6).
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessEvent } from '../../ports/harness';
import type { Budget } from '../../ports/types';

/** Where a budget's warning comes. */
export const WARN_AT = 0.8;

const MINUTE_MS = 60_000;

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

type Name = 'turns' | 'usd' | 'minutes';

export function createBudgetWatch(options: BudgetWatchOptions): BudgetWatch {
  const { budget, timers } = options;
  const limits: Record<Name, number> = { turns: budget.maxTurns, usd: budget.maxUsd, minutes: budget.maxMinutes };
  const given = new Set<string>();
  const handles: unknown[] = [];
  let startedAt = 0;

  /** Emits `kind` of `name` at `used`, once per session. */
  const once = (name: Name, kind: 'warning' | 'exceeded', used: number): void => {
    if (given.has(`${name}:${kind}`)) return;
    given.add(`${name}:${kind}`);
    options.emit({ type: `budget:${kind}`, budget: name, limit: limits[name], used });
  };
  const warnAt = (name: Name, used: number): void => {
    if (used >= WARN_AT * limits[name]) once(name, 'warning', used);
  };
  const minutesUsed = () => (options.now() - startedAt) / MINUTE_MS;

  return {
    turn: (n) => warnAt('turns', n),
    start() {
      startedAt = options.now();
      handles.push(
        timers.set(() => once('minutes', 'warning', minutesUsed()), WARN_AT * budget.maxMinutes * MINUTE_MS),
        timers.set(() => {
          once('minutes', 'exceeded', minutesUsed());
          options.onOverMinutes();
        }, budget.maxMinutes * MINUTE_MS),
      );
    },
    stop() {
      for (const handle of handles.splice(0)) timers.clear(handle);
    },
    result(result) {
      warnAt('usd', result.total_cost_usd);
      if (result.subtype === 'error_max_budget_usd') once('usd', 'exceeded', result.total_cost_usd);
      if (result.subtype === 'error_max_turns') {
        once('turns', 'warning', result.num_turns);
        once('turns', 'exceeded', result.num_turns);
      }
    },
  };
}
