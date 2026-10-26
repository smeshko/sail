// What the terminal view draws of a run's budget (budget-view.ts): the lines of the run's own budget events and of a
// raise, and the final block's cost row against the budget as raised.
import { expect, test } from 'bun:test';
import { usedOf } from '../../../src/engine/budget';
import { budgetText, createBudgetView, raisedText } from '../../../src/events/consumers/budget-view';
import type { NewEvent, SailEvent } from '../../../src/events/types';
import { runStart, session, stamp } from '../../helpers/events';

type Of<T extends SailEvent['type']> = Extract<SailEvent, { type: T }>;

/** `event`, stamped as the bus would. */
const one = <T extends SailEvent['type']>(event: NewEvent & { type: T }): Of<T> => stamp([0, event])[0] as Of<T>;

const ended = (key: string, costUsd: number): NewEvent =>
  session(key, { turns: 1, toolCalls: 0, denials: 0, usage: { costUsd } });

test("the run's warning and its exceeded budget print what was used of the limit, in dollars or in minutes", () => {
  expect([
    budgetText(one({ type: 'budget:warning', budget: 'usd', limit: 0.5, used: 0.4077 })),
    budgetText(one({ type: 'budget:warning', budget: 'minutes', limit: 90, used: 72 })),
    budgetText(one({ type: 'budget:exceeded', budget: 'usd', limit: 0.5, used: 0.5029 })),
  ]).toEqual(['budget usd at $0.41 of $0.50', 'budget minutes at 72 of 90 min', 'budget usd exceeded: $0.50 of $0.50']);
});

test('a raise prints what it added and the budget after it: dollars, minutes, or both', () => {
  expect([
    raisedText(one({ type: 'budget:raised', usd: 5, budget: { maxUsd: 5.5, maxMinutes: 90 } })),
    raisedText(one({ type: 'budget:raised', minutes: 30, budget: { maxMinutes: 120 } })),
    raisedText(one({ type: 'budget:raised', usd: 5, minutes: 30, budget: { maxUsd: 5.5, maxMinutes: 120 } })),
    raisedText(one({ type: 'budget:raised', usd: 0.0000001, budget: { maxUsd: 0.5 } })),
  ]).toEqual([
    'budget raised by $5.00: now $5.50',
    'budget raised by 30 min: now 120 min',
    'budget raised by $5.00 and 30 min: now $5.50 and 120 min',
    'budget raised by $0.00: now $0.50',
  ]);
});

test("the cost row is what the sessions spent against the run's dollar budget, as raised, or alone with no budget, and absent while nothing was spent", () => {
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

test('the cost row counts an open session at its last usage reading, as the budget tracker does, and a reopened key once', () => {
  const rowAfter = (...list: NewEvent[]) => {
    const events = stamp(...list.map((event, i): [number, NewEvent] => [i, event]));
    const view = createBudgetView();
    for (const event of events) view.update(event);
    return { row: view.costRow(), tracked: usedOf(events).usd };
  };
  const open = (key: string): NewEvent => ({
    type: 'harness:session_start',
    key,
    adapter: 'fake',
    sessionId: `session-${key}`,
    model: 'fake',
  });
  const reading = (key: string, costUsdSoFar: number): NewEvent => ({
    type: 'usage:update',
    key,
    turn: 1,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    costUsdSoFar,
  });
  const base = [runStart({ maxUsd: 0.5 }), ended('spec#1', 0.3125)];
  const opened = rowAfter(...base, open('implement#1'), reading('implement#1', 0.1));
  const reopened = rowAfter(
    ...base,
    open('implement#1'),
    reading('implement#1', 0.1),
    open('implement#1'),
    reading('implement#1', 0.05),
  );
  const bare = rowAfter(runStart({ maxUsd: 0.5 }), open('implement#1'));
  expect([opened.row, reopened.row, bare.row]).toEqual([
    ['cost', '$0.41 of $0.50 (82.5%)'],
    ['cost', '$0.46 of $0.50 (92.5%)'],
    undefined,
  ]);
  expect([opened.tracked, reopened.tracked]).toEqual([0.4125, 0.4625]);
  for (const { row, tracked } of [opened, reopened]) {
    expect(row?.[1].startsWith(`$${tracked.toFixed(2)} of `)).toBe(true);
  }
});
