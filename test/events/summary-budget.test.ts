// The summary's totals.budget follows a raise: `sail show` prints usage against the run's budget as raised.
import { expect, test } from 'bun:test';
import { validateDocument } from '../../src/engine/schemas';
import { emptyState, foldEvent, toSummary } from '../../src/events/summary';
import type { NewEvent } from '../../src/events/types';
import { end, runEnd, runStart, session, stamp, start } from '../helpers/events';

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a summary folded from a run with a $0.50 budget raised to $5.50 holds the raised budget and what was used of it, and validates as sail.summary.v1', () => {
  const list: NewEvent[] = [
    runStart({ maxUsd: 0.5, maxMinutes: 90 }),
    start('spec#1', { kind: 'agent' }),
    session('spec#1', { turns: 4, toolCalls: 0, denials: 0, usage: { costUsd: 0.5029 } }),
    end('spec#1', 'done', 1200),
    runEnd('suspended', 2, { stopReason: 'interrupted' }),
    { type: 'budget:raised', usd: 5, budget: { maxUsd: 5.5, maxMinutes: 90 } },
  ];
  const state = emptyState();
  for (const event of stamp(...list.map((event, i): [number, NewEvent] => [i * 100, event]))) foldEvent(state, event);
  const summary = toSummary(state);
  expect({ budget: summary?.totals.budget, issues: validateDocument('sail.summary.v1', summary) }).toEqual({
    budget: { maxUsd: 5.5, usedPct: 9.1 },
    issues: [],
  });
});
