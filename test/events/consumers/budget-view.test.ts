// What the terminal view draws of a run's budget (budget-view.ts): the lines of the run's own budget events and of a
// raise, and the final block's cost row against the budget as raised.
import { expect, test } from 'bun:test';
import { budgetText, createBudgetView, raisedText } from '../../../src/events/consumers/budget-view';
import type { NewEvent, SailEvent } from '../../../src/events/types';
import { runStart, session, stamp } from '../../helpers/events';

type Of<T extends SailEvent['type']> = Extract<SailEvent, { type: T }>;

/** `event`, stamped as the bus would. */
const one = <T extends SailEvent['type']>(event: NewEvent & { type: T }): Of<T> => stamp([0, event])[0] as Of<T>;

const ended = (key: string, costUsd: number): NewEvent =>
  session(key, { turns: 1, toolCalls: 0, denials: 0, usage: { costUsd } });

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ("the run's warning and its exceeded budget print what was used of the limit, in dollars or in minutes", () => {
  expect([
    budgetText(one({ type: 'budget:warning', budget: 'usd', limit: 0.5, used: 0.4077 })),
    budgetText(one({ type: 'budget:warning', budget: 'minutes', limit: 90, used: 72 })),
    budgetText(one({ type: 'budget:exceeded', budget: 'usd', limit: 0.5, used: 0.5029 })),
  ]).toEqual(['budget usd at $0.41 of $0.50', 'budget minutes at 72 of 90 min', 'budget usd exceeded: $0.50 of $0.50']);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a raise prints what it added and the budget after it: dollars, minutes, or both', () => {
  expect([
    raisedText(one({ type: 'budget:raised', usd: 5, budget: { maxUsd: 5.5, maxMinutes: 90 } })),
    raisedText(one({ type: 'budget:raised', minutes: 30, budget: { maxMinutes: 120 } })),
    raisedText(one({ type: 'budget:raised', usd: 5, minutes: 30, budget: { maxUsd: 5.5, maxMinutes: 120 } })),
  ]).toEqual([
    'budget raised by $5: now $5.50',
    'budget raised by 30 min: now 120 min',
    'budget raised by $5 and 30 min: now $5.50 and 120 min',
  ]);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ("the cost row is what the sessions spent against the run's dollar budget, as raised, or alone with no budget, and absent while nothing was spent", () => {
  const rowAfter = (...list: NewEvent[]) => {
    const view = createBudgetView();
    for (const event of stamp(...list.map((event, i): [number, NewEvent] => [i, event]))) view.update(event);
    return view.costRow();
  };
  const spent = [ended('spec#1', 0.3125), ended('implement#1', 0.1904)];
  expect([
    rowAfter(runStart({ maxUsd: 0.5, maxMinutes: 90 }), ...spent),
    rowAfter(runStart({ maxUsd: 0.5 }), ...spent, { type: 'budget:raised', usd: 5, budget: { maxUsd: 5.5 } }),
    rowAfter(runStart(), ended('spec#1', 0.3125)),
    rowAfter(runStart({ maxUsd: 0.5 })),
  ]).toEqual([['cost', '$0.50 of $0.50 (100.6%)'], ['cost', '$0.50 of $5.50 (9.1%)'], ['cost', '$0.31'], undefined]);
});
