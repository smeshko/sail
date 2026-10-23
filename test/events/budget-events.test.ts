// run:suspended and budget:raised in sail.event.v1: a run suspended on its budget, and a raise of it. Both are the
// run's own events, with no key, and their payloads are closed.
import { expect, test } from 'bun:test';
import { validateDocument } from '../../src/engine/schemas';

const envelope = { seq: 9, ts: '2026-10-23T09:00:00.000Z', runId: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N' };

const suspended = {
  ...envelope,
  type: 'run:suspended',
  stopReason: 'budget_exceeded',
  budget: 'usd',
  limit: 0.5,
  used: 0.5029,
};

const raised = { ...envelope, type: 'budget:raised', usd: 5, budget: { maxUsd: 5.5, maxMinutes: 90 } };

/** Where `event` breaks sail.event.v1: each issue's path. */
const paths = (event: Record<string, unknown>): string[] =>
  validateDocument('sail.event.v1', event).map((issue) => issue.path);

function omit(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _, ...rest } = data;
  return rest;
}

// biome-ignore format: TDD-PENDING TASK-001
test
  .skip // TDD-PENDING TASK-001
  ('a run:suspended with its stop reason, budget, limit and use validates, and one with a key, another stop reason or no use is refused naming the field', () => {
  expect({
    valid: paths(suspended),
    minutes: paths({ ...suspended, budget: 'minutes', limit: 90, used: 90.2 }),
    key: paths({ ...suspended, key: 'implement#1' }),
    stopReason: paths({ ...suspended, stopReason: 'interrupted' }),
    used: paths(omit(suspended, 'used')),
    turns: paths({ ...suspended, budget: 'turns' }),
  }).toEqual({
    valid: [],
    minutes: [],
    key: ['/key'],
    stopReason: ['/stopReason'],
    used: ['/used'],
    turns: ['/budget'],
  });
});

// biome-ignore format: TDD-PENDING TASK-001
test
  .skip // TDD-PENDING TASK-001
  ('a budget:raised of dollars, of minutes or of both validates with the budget after it, and one with neither, a zero raise or another field is refused naming it', () => {
  expect({
    usd: paths(raised),
    minutes: paths({ ...omit(raised, 'usd'), minutes: 30, budget: { maxMinutes: 120 } }),
    both: paths({ ...raised, minutes: 30, budget: { maxUsd: 5.5, maxMinutes: 120 } }),
    neither: paths(omit(raised, 'usd')),
    zero: paths({ ...raised, usd: 0 }),
    extra: paths({ ...raised, by: 'ivo' }),
    key: paths({ ...raised, key: 'spec#1' }),
    budget: paths(omit(raised, 'budget')),
  }).toEqual({
    usd: [],
    minutes: [],
    both: [],
    neither: ['/usd', '/minutes', '/'],
    zero: ['/usd'],
    extra: ['/by'],
    key: ['/key'],
    budget: ['/budget'],
  });
});
