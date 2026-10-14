// fakeTimers(): the poller's timers on a clock that moves only when a test moves it. `advance(ms)` runs every callback
// that comes due, in order, at its own time, and awaits the promise each returns, so a poll a timer starts has finished
// when `advance` resolves.
import type { Timers } from '../../src/watch/poll';

interface Pending {
  id: number;
  due: number;
  ms: number;
  fn: () => unknown;
}

export interface FakeTimers extends Timers {
  /** The timers set and not yet run or cleared, soonest first: each one's delay as it was set. */
  pending(): { ms: number; due: number }[];
  /** Moves the clock on by `ms`, running what comes due. */
  advance(ms: number): Promise<void>;
  /** The fake clock's time. */
  now(): Date;
}

export function fakeTimers(start: string): FakeTimers {
  let at = Date.parse(start);
  let next = 1;
  const timers: Pending[] = [];
  const soonest = () => [...timers].sort((a, b) => a.due - b.due || a.id - b.id);
  return {
    set(fn, ms) {
      const timer = { id: next++, due: at + ms, ms, fn };
      timers.push(timer);
      return timer.id;
    },
    clear(handle) {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index !== -1) timers.splice(index, 1);
    },
    pending: () => soonest().map(({ ms, due }) => ({ ms, due })),
    async advance(ms) {
      const until = at + ms;
      for (let timer = soonest()[0]; timer !== undefined && timer.due <= until; timer = soonest()[0]) {
        timers.splice(timers.indexOf(timer), 1);
        at = timer.due;
        await timer.fn();
      }
      at = until;
    },
    now: () => new Date(at),
  };
}
