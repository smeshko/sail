// The budget watch: a warning once when what is used first reaches 80% of a budget, an overrun once when it is used up,
// turns as they close, dollars at the result, and minutes on a timer that ends the session (D6, D13). Fake timers only.
import { expect, test } from 'bun:test';
import { createBudgetWatch } from '../../../src/adapters/claude-code/budget';
import type { HarnessEvent } from '../../../src/ports/harness';
import { fakeTimers } from '../../helpers/fake-timers';

/** A watch over `budget` on fake timers, with every event it emitted and each time the minutes ran out. */
function watch(budget = { maxTurns: 10, maxUsd: 0.05, maxMinutes: 1 }) {
  const timers = fakeTimers('2026-10-15T09:00:00.000Z');
  const events: HarnessEvent[] = [];
  let over = 0;
  const made = createBudgetWatch({
    budget,
    timers,
    now: () => timers.now().getTime(),
    emit: (event) => events.push(event),
    onOverMinutes: () => {
      over++;
    },
  });
  return { watch: made, timers, events, over: () => over };
}

test('turns warn once, at the first close that reaches 80%, and their overrun follows at the result without a second warning', () => {
  const { watch: w, events } = watch();
  for (const n of [1, 7, 8, 9]) w.turn(n);
  w.settle({ usd: 0.001, turns: 10, over: 'turns' });
  expect(events).toEqual([
    { type: 'budget:warning', budget: 'turns', limit: 10, used: 8 },
    { type: 'budget:exceeded', budget: 'turns', limit: 10, used: 10 },
  ]);
});

test('a turns overrun with no warning yet gives the warning first', () => {
  const { watch: w, events } = watch();
  w.turn(1);
  w.settle({ usd: 0.001, turns: 10, over: 'turns' });
  expect(events.map((event) => `${event.type} ${'budget' in event ? event.budget : ''}`)).toEqual([
    'budget:warning turns',
    'budget:exceeded turns',
  ]);
});

test('dollars warn when settled at 80%, overrun only with over: usd, and stay quiet below', () => {
  const below = watch();
  below.watch.settle({ usd: 0.01, turns: 1 });
  const near = watch();
  near.watch.settle({ usd: 0.045, turns: 1 });
  const over = watch();
  over.watch.settle({ usd: 0.051, turns: 1, over: 'usd' });
  expect({ below: below.events, near: near.events, over: over.events }).toEqual({
    below: [],
    near: [{ type: 'budget:warning', budget: 'usd', limit: 0.05, used: 0.045 }],
    over: [
      { type: 'budget:warning', budget: 'usd', limit: 0.05, used: 0.051 },
      { type: 'budget:exceeded', budget: 'usd', limit: 0.05, used: 0.051 },
    ],
  });
});

test('settling over turns gives the warning then the overrun, and over dollars below 80% gives the overrun alone', () => {
  const turns = watch();
  turns.watch.settle({ usd: 0, turns: 3, over: 'turns' });
  const usd = watch();
  usd.watch.settle({ usd: 0.02, turns: 1, over: 'usd' });
  expect({ turns: turns.events, usd: usd.events }).toEqual({
    turns: [
      { type: 'budget:warning', budget: 'turns', limit: 10, used: 3 },
      { type: 'budget:exceeded', budget: 'turns', limit: 10, used: 3 },
    ],
    usd: [{ type: 'budget:exceeded', budget: 'usd', limit: 0.05, used: 0.02 }],
  });
});

test('minutes warn at 80% on the clock and overrun at the budget, once, then end the session; stop clears what is left', async () => {
  const { watch: w, timers, events, over } = watch();
  w.start();
  expect(timers.pending().map((timer) => timer.ms)).toEqual([48_000, 60_000]);
  await timers.advance(47_999);
  const early = events.length;
  await timers.advance(1);
  await timers.advance(12_000);
  w.stop();
  expect({ early, events, over: over(), pending: timers.pending() }).toEqual({
    early: 0,
    events: [
      { type: 'budget:warning', budget: 'minutes', limit: 1, used: 0.8 },
      { type: 'budget:exceeded', budget: 'minutes', limit: 1, used: 1 },
    ],
    over: 1,
    pending: [],
  });
});

test('a watch stopped before its minutes are up leaves no timer and says nothing of them', async () => {
  const { watch: w, timers, events } = watch();
  w.start();
  const set = timers.pending().length;
  await timers.advance(30_000);
  w.stop();
  await timers.advance(60_000);
  expect({ set, pending: timers.pending(), events }).toEqual({ set: 2, pending: [], events: [] });
});

// Review R1-9: a timer longer than 2^31 - 1 ms fires at once, so a long minute budget is timed in steps no timer
// overflows, and ends when it is used up, not at the start.
test('a minute budget past the longest timer sets no timer beyond it, and runs out only when it is used up', async () => {
  const { watch: w, timers, events, over } = watch({ maxTurns: 10, maxUsd: 1, maxMinutes: 50_000 });
  w.start();
  const longest = Math.max(...timers.pending().map((timer) => timer.ms));
  await timers.advance(49_999 * 60_000);
  const early = { events: events.map((event) => event.type), over: over() };
  await timers.advance(60_000);
  expect({ longest: longest <= 2 ** 31 - 1, early, over: over() }).toEqual({
    longest: true,
    early: { events: ['budget:warning'], over: 0 },
    over: 1,
  });
  w.stop();
});
