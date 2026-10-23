// A run's budget: the most one run may use, in dollars and in minutes, and what it has used of it.
//
// - The budget is `project.yaml`'s `budgets.run`, which a workflow's own `budget` overrides field by field, frozen in
//   `run.json` at the start. A raise given to `sail resume` adds to it, and is recorded as a `budget:raised` event:
//   `run.json` keeps the budget the run started with (ADR-0002).
// - What a run has used is folded from its own events, never kept in a file of its own. Its dollars are each session's
//   `harness:session_end`, and an open session's last `usage:update`. A session is open from its `session_start` to
//   its `session_end`, and a new `session_start` under a key that is still open settles the old one at its last
//   reading, so no session counts twice.
// - Its minutes are its active time: each process's segment of the events' `ts`, from `run:start` or a resume's
//   key-less `workspace:leased` to that process's `run:end` or `error:crash`, or else its last event. So the days a
//   run spends suspended, or dead after a crash, aren't counted. The running process's own minutes come from a
//   monotonic `elapsed()`, never from the run's clock, so tracking a budget moves no `ts`.
// - The tracker never aborts a call. Each agent request is handed its share of what the run has left, through a
//   Harness wrapper, and the harness ends a session that reaches it, as it ends one at its step's own budget. A share is
//   what is left less what the other open requests hold of theirs, so sessions that run at once can't each use the
//   whole remainder. Minutes are not reserved: sessions that run at once use the same minutes.
// - A session's end and a raise are confirmed on disk: `events.ndjson` must end with that event, and is then synced. The
//   bus swallows a consumer's failure, so one that can't be confirmed is latched, and the runtime crashes the run with
//   it before anything else is journaled.
// - `budget:warning` fires once per budget and limit at 80% of it, and `budget:exceeded` once at the limit. Both are the
//   run's, with no key: a step's own carry their call's.
import { join } from 'node:path';
import { EVENTS_FILE, holdsSeq, lastSeq } from '../events/consumers/ndjson';
import type { NewEvent, SailEvent } from '../events/types';
import type { Harness } from '../ports/harness';
import { syncFile } from './durable';
import type { RunHeader } from './run-header';

/** The most one run may use: dollars, minutes, or both. */
export type RunBudget = NonNullable<RunHeader['budget']>;

/** The share of a budget at which its warning fires. */
export const WARN_AT = 0.8;

const FIELDS = ['maxUsd', 'maxMinutes'] as const;

/** `workflow`'s budget over `project`'s, field by field, keeping only the fields given: undefined when none is. */
export function runBudgetOf(project: RunBudget | undefined, workflow: RunBudget | undefined): RunBudget | undefined {
  const merged: { maxUsd?: number; maxMinutes?: number } = {};
  for (const field of FIELDS) {
    const value = workflow?.[field] ?? project?.[field];
    if (value !== undefined) merged[field] = value;
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/** What is wrong with a workflow's `budget`, or undefined when it is left out or sound. */
export function workflowBudgetProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'must be an object of maxUsd and maxMinutes';
  }
  for (const [field, given] of Object.entries(value)) {
    if (!(FIELDS as readonly string[]).includes(field)) return `has ${field}, which no run budget has`;
    if (typeof given !== 'number' || !Number.isFinite(given) || given < 0) {
      return `${field} must be a number of 0 or more: ${typeof given === 'number' ? given : JSON.stringify(given)}`;
    }
  }
  return undefined;
}

/** What a run has used: dollars, and minutes of active time. */
export interface RunUsed {
  usd: number;
  minutes: number;
}

/** A budget the run has used up: which, its limit and what was used. */
export interface Over {
  budget: 'usd' | 'minutes';
  limit: number;
  used: number;
}

/** Summed dollars and minutes without the float noise, to 6 decimals. */
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * The least dollars a request is handed, the rounding's unit: `claude-code`'s CLI refuses `--max-budget-usd 0`, so a
 * request the others' shares leave nothing still runs its one turn, as a share of 0 would on the fake (D12, D13).
 */
const LEAST_SHARE_USD = 0.000001;

/** The dollars fold: what settled sessions spent, and each open session's last reading by key. */
interface Dollars {
  settled: number;
  open: Map<string, number>;
}

function foldDollars(dollars: Dollars, event: SailEvent): void {
  switch (event.type) {
    case 'harness:session_start': {
      const last = dollars.open.get(event.key);
      if (last !== undefined) dollars.settled += last;
      dollars.open.set(event.key, 0);
      return;
    }
    case 'usage:update':
      dollars.open.set(event.key, event.costUsdSoFar);
      return;
    case 'harness:session_end':
      dollars.settled += event.usage.costUsd;
      dollars.open.delete(event.key);
  }
}

const dollarsOf = (dollars: Dollars): number => {
  let sum = dollars.settled;
  for (const reading of dollars.open.values()) sum += reading;
  return round(sum);
};

/** Opens a process's segment: `run:start`, or a key-less `workspace:leased` that doesn't follow one, as a resume's. */
const opensSegment = (event: SailEvent, previous: SailEvent | undefined): boolean =>
  event.type === 'run:start' ||
  (event.type === 'workspace:leased' && !('key' in event) && previous?.type !== 'run:start');

/** The minutes of active time `events` hold: each segment from its start to its end, or else its last event. */
function minutesOf(events: readonly SailEvent[]): number {
  let ms = 0;
  let from: number | undefined;
  let last: number | undefined;
  for (const [index, event] of events.entries()) {
    const at = Date.parse(event.ts);
    if (opensSegment(event, events[index - 1])) {
      if (from !== undefined && last !== undefined) ms += last - from;
      from = at;
    }
    if (from === undefined) continue;
    last = at;
    if (event.type === 'run:end' || event.type === 'error:crash') {
      ms += last - from;
      from = undefined;
    }
  }
  if (from !== undefined && last !== undefined) ms += last - from;
  return ms / 60_000;
}

/** What the run whose events these are has used. */
export function usedOf(events: readonly SailEvent[]): RunUsed {
  const dollars: Dollars = { settled: 0, open: new Map() };
  for (const event of events) foldDollars(dollars, event);
  return { usd: dollarsOf(dollars), minutes: round(minutesOf(events)) };
}

/** The run's budget now: the header's, with the last raise's budget over it. */
export function budgetAfterRaises(budget: RunBudget | undefined, events: readonly SailEvent[]): RunBudget | undefined {
  const raised = events.findLast((event) => event.type === 'budget:raised');
  return raised === undefined ? budget : { ...budget, ...raised.budget };
}

/** What a raise adds: dollars, minutes, or both. */
export interface Raise {
  usd?: number;
  minutes?: number;
}

/** `budget` with `raise` added to it. */
function raised(budget: RunBudget, raise: Raise): RunBudget {
  const after: { maxUsd?: number; maxMinutes?: number } = { ...budget };
  if (raise.usd !== undefined && after.maxUsd !== undefined) after.maxUsd = round(after.maxUsd + raise.usd);
  if (raise.minutes !== undefined && after.maxMinutes !== undefined) {
    after.maxMinutes = round(after.maxMinutes + raise.minutes);
  }
  return after;
}

/** The budget `budget` has used up, given what was used: dollars first. */
function overOf(budget: RunBudget, used: RunUsed): Over | undefined {
  if (budget.maxUsd !== undefined && used.usd >= budget.maxUsd) {
    return { budget: 'usd', limit: budget.maxUsd, used: used.usd };
  }
  if (budget.maxMinutes !== undefined && used.minutes >= budget.maxMinutes) {
    return { budget: 'minutes', limit: budget.maxMinutes, used: used.minutes };
  }
  return undefined;
}

const usd = (value: number): string => `$${value.toFixed(2)}`;
const minutes = (value: number): string => String(Math.round(value * 100) / 100);

/** What was used of a budget, for people: `$0.50 of its $0.50`, `90 of its 90 minutes`. */
const usedText = ({ budget, limit, used }: Over): string =>
  budget === 'usd' ? `${usd(used)} of its ${usd(limit)}` : `${minutes(used)} of its ${minutes(limit)} minutes`;

/** The flag that raises a budget, with its value's name. */
export const raiseFlag = (budget: Over['budget']): string =>
  budget === 'usd' ? '--raise-budget <usd>' : '--raise-minutes <minutes>';

/** A run suspended on its budget before `before`: its `run:suspended`, and why, for people. */
export function suspension(over: Over, before: string): { event: NewEvent; message: string } {
  return {
    event: { type: 'run:suspended', stopReason: 'budget_exceeded', ...over },
    message: `${usedText(over)} used before ${before}: raise it with ${raiseFlag(over.budget)}`,
  };
}

/**
 * Why run `runId` can't resume with `raise`, from its header's budget and its events, or undefined when it can: a raise
 * of a budget the run doesn't have, one too large for the budget after it to be a finite number, which the events file
 * would hold as `null`, or a run still at or over its budget once the raise is added. A resume with no raise is held to
 * the last.
 */
export function raiseProblem(
  runId: string,
  budget: RunBudget | undefined,
  events: readonly SailEvent[],
  raise: Raise = {},
): string | undefined {
  const now = budgetAfterRaises(budget, events);
  if (raise.usd !== undefined && now?.maxUsd === undefined) return `run ${runId} has no dollar budget to raise`;
  if (raise.minutes !== undefined && now?.maxMinutes === undefined) return `run ${runId} has no minute budget to raise`;
  if (now === undefined) return undefined;
  const after = raised(now, raise);
  for (const [field, name] of [
    ['maxUsd', 'dollar'],
    ['maxMinutes', 'minute'],
  ] as const) {
    const value = after[field];
    if (value !== undefined && !Number.isFinite(value)) {
      return `run ${runId} can't take that raise: its ${name} budget would be more than a number holds`;
    }
  }
  const over = overOf(after, usedOf(events));
  if (over === undefined) return undefined;
  return `run ${runId} has used ${usedText(over)}: resume it with ${raiseFlag(over.budget)}`;
}

export interface BudgetOptions {
  /** The run's budget, from its header. */
  budget: RunBudget | undefined;
  /** The run's events when its drive loop starts: none for a fresh run. */
  prior: readonly SailEvent[];
  /** Emits the run's own budget events, and returns each stamped. */
  emit: (event: NewEvent) => SailEvent;
  /** Confirms `event` reached the disk, or throws. */
  record: (event: SailEvent) => void;
  /** Monotonic milliseconds: this process's active time is read from it. */
  elapsed: () => number;
}

export interface BudgetTracker {
  /** Folds one of the run's events, confirms a session's end on disk, and emits what has come due. */
  observe(event: SailEvent): void;
  /** The budget the run has used up, dollars first, or undefined while it has some left. Emits what has come due. */
  over(): Over | undefined;
  /** Throws the failure to confirm a session's end on disk, if one came. */
  assertRecorded(): void;
  /**
   * Whether the last request under `key` was handed less than its step's own budget: in the budget its session said it
   * exceeded, when it said which, or else in either.
   */
  narrowed(key: string): boolean;
  /** `inner`, handing each request its share of what the run has left. */
  harness(inner: Harness): Harness;
  /** Adds `raise` to the budget, emits it as `budget:raised`, and confirms it on disk: a failure throws. */
  raise(raise: Raise): void;
}

/** The tracker of a run's budget, or undefined for a run that has none. */
export function trackBudget(options: BudgetOptions): BudgetTracker | undefined {
  const { prior, emit, record, elapsed } = options;
  const initial = budgetAfterRaises(options.budget, prior);
  if (initial === undefined) return undefined;
  let budget: RunBudget = initial;
  const dollars: Dollars = { settled: 0, open: new Map() };
  for (const event of prior) foldDollars(dollars, event);
  const earlier = minutesOf(prior);
  const since = elapsed();
  /** The run-level warnings and exceeded given, as `<event type> <budget> <limit>`. */
  const given = new Set<string>();
  for (const event of prior) {
    if ((event.type === 'budget:warning' || event.type === 'budget:exceeded') && event.key === undefined) {
      given.add(`${event.type} ${event.budget} ${event.limit}`);
    }
  }
  /** What each open request was handed, by key. */
  const shares = new Map<string, number>();
  /** The budgets each key's last request was narrowed in, and the one its session said it exceeded. */
  const narrowedIn = new Map<string, Over['budget'][]>();
  const exceededIn = new Map<string, string>();
  let unrecorded: unknown;

  const used = (): RunUsed => ({ usd: dollarsOf(dollars), minutes: round(earlier + (elapsed() - since) / 60_000) });

  /** Emits a run-level budget event once per type, budget and limit. */
  const once = (type: 'budget:warning' | 'budget:exceeded', of: Over['budget'], limit: number, value: number) => {
    const id = `${type} ${of} ${limit}`;
    if (given.has(id)) return;
    given.add(id);
    emit({ type, budget: of, limit, used: value });
  };
  /** Emits each warning and exceeded that has come due, and answers with what was used. */
  const due = (): RunUsed => {
    const now = used();
    const each: [Over['budget'], number | undefined, number][] = [
      ['usd', budget.maxUsd, now.usd],
      ['minutes', budget.maxMinutes, now.minutes],
    ];
    for (const [of, limit, value] of each) {
      if (limit === undefined) continue;
      if (value >= WARN_AT * limit) once('budget:warning', of, limit, value);
      if (value >= limit) once('budget:exceeded', of, limit, value);
    }
    return now;
  };

  /** The dollars `key`'s request may be handed: what is left less what the other open requests still hold. */
  const leftFor = (key: string, maxUsd: number): number => {
    let held = 0;
    for (const [other, share] of shares) {
      if (other !== key) held += Math.max(0, share - (dollars.open.get(other) ?? 0));
    }
    return Math.max(LEAST_SHARE_USD, round(maxUsd - dollarsOf(dollars) - held));
  };

  return {
    observe(event) {
      if (event.type === 'budget:exceeded' && event.key !== undefined) exceededIn.set(event.key, event.budget);
      foldDollars(dollars, event);
      if (event.type === 'harness:session_end' && unrecorded === undefined) {
        try {
          record(event);
        } catch (error) {
          unrecorded = error;
        }
      }
      due();
    },
    over: () => overOf(budget, due()),
    assertRecorded() {
      if (unrecorded !== undefined) throw unrecorded;
    },
    narrowed(key) {
      const narrowed = narrowedIn.get(key) ?? [];
      const exceeded = exceededIn.get(key);
      return exceeded === undefined ? narrowed.length > 0 : (narrowed as string[]).includes(exceeded);
    },
    harness(inner) {
      return {
        name: inner.name,
        capabilities: () => inner.capabilities(),
        async run(request) {
          const { key } = request;
          const own = request.budget;
          let { maxUsd, maxMinutes } = own;
          if (budget.maxUsd !== undefined) maxUsd = Math.min(own.maxUsd, leftFor(key, budget.maxUsd));
          if (budget.maxMinutes !== undefined) {
            const left = budget.maxMinutes - used().minutes;
            maxMinutes = Math.max(Number.EPSILON, Math.min(own.maxMinutes, left));
          }
          shares.set(key, maxUsd);
          narrowedIn.set(key, [
            ...(maxUsd < own.maxUsd ? ['usd' as const] : []),
            ...(maxMinutes < own.maxMinutes ? ['minutes' as const] : []),
          ]);
          exceededIn.delete(key);
          try {
            return await inner.run({ ...request, budget: { ...own, maxUsd, maxMinutes } });
          } finally {
            shares.delete(key);
          }
        },
      };
    },
    raise(given) {
      const after = raised(budget, given);
      const stamped = emit({ type: 'budget:raised', ...given, budget: after });
      budget = after;
      record(stamped);
    },
  };
}

/**
 * Confirms an event of the run in `runDir` reached the disk: its events file must hold its line, and is then synced.
 * Lines after it are no failure: the bus appends a consumer's `error:consumer` within the same emit.
 */
export function recordIn(runDir: string): (event: SailEvent) => void {
  return (event) => {
    if (!holdsSeq(runDir, event.seq)) {
      const last = lastSeq(runDir);
      const why = last === undefined ? 'ends with no event' : `ends with event ${last}`;
      throw new Error(`${EVENTS_FILE} ${why}, not ${event.type} ${event.seq}: it is not on disk`);
    }
    syncFile(join(runDir, EVENTS_FILE));
  };
}
