// The runtime rules for a watched workflow: its interval, its bound, its label and an intake the watcher can poll for.
import { expect, test } from 'bun:test';
import { parseEvery, pollKind, watchLabel, watchProblem } from '../../src/engine/watchable';
import { intake, type Workflow, workflow, z } from '../../src/sdk/index';
import { ticket } from '../../src/sdk/intakes';

/** A workflow on the `ticket` intake with `options` as declared, past the types: these cases are what types miss. */
const declared = (options: Record<string, unknown>, on = ticket): Workflow =>
  workflow('watched', { intake: on, ...options } as never, async () => {}) as unknown as Workflow;

const prOnly = intake('pr-review', { accepts: ['pr'], output: z.object({}) });

test.each([
  ['30s', 30_000],
  ['5m', 300_000],
  ['1.5h', 5_400_000],
  ['29s', undefined],
  ['0m', undefined],
  ['5', undefined],
  ['5 min', undefined],
  ['-1m', undefined],
  ['1e3s', undefined],
  [5, undefined],
  [undefined, undefined],
] as const)('parseEvery(%p) is %p', (every, ms) => {
  expect(parseEvery(every)).toBe(ms);
});

test.each([
  [
    'watch without maxConcurrentRuns',
    { watch: { every: '5m' } },
    'declares watch without maxConcurrentRuns: a watched workflow bounds its runs',
  ],
  [
    'maxConcurrentRuns without watch',
    { maxConcurrentRuns: 2 },
    'declares maxConcurrentRuns without watch: only a watched workflow bounds its runs',
  ],
  [
    'a cap of 0',
    { watch: { every: '5m' }, maxConcurrentRuns: 0 },
    'has maxConcurrentRuns 0, which is not a whole number of 1 or more',
  ],
  [
    'a cap of 1.5',
    { watch: { every: '5m' }, maxConcurrentRuns: 1.5 },
    'has maxConcurrentRuns 1.5, which is not a whole number of 1 or more',
  ],
  [
    "a cap of '2'",
    { watch: { every: '5m' }, maxConcurrentRuns: '2' },
    'has maxConcurrentRuns "2", which is not a whole number of 1 or more',
  ],
  [
    'every 10s',
    { watch: { every: '10s' }, maxConcurrentRuns: 2 },
    'has watch.every "10s", which is not a number of s, m or h of at least 30s',
  ],
  [
    'an empty label',
    { watch: { every: '5m', label: '' }, maxConcurrentRuns: 2 },
    'has watch.label "", and a label is a non-empty string',
  ],
  [
    'a blank label',
    { watch: { every: '5m', label: '  ' }, maxConcurrentRuns: 2 },
    'has watch.label "  ", and a label is a non-empty string',
  ],
])('watchProblem names the fault: %s', (_, options, message) => {
  expect(watchProblem(declared(options))).toBe(message);
});

const both = intake('both', { accepts: ['ticket', 'pr'], output: z.object({}) });
const none = intake('none', { accepts: [], output: z.object({}) });

test('watchProblem takes an intake that accepts pr, refuses one that accepts both kinds or none, and pollKind names the kind a watched workflow polls (ADW-235)', () => {
  const watch = { watch: { every: '5m' }, maxConcurrentRuns: 2 };
  expect({
    problems: [prOnly, both, none].map((on) => watchProblem(declared(watch, on as never))),
    kinds: [pollKind(declared(watch)), pollKind(declared(watch, prOnly as never))],
  }).toEqual({
    problems: [
      undefined,
      "its intake 'both' accepts ticket and pr, and a watched workflow polls one kind of source",
      "its intake 'none' accepts nothing, and sail polls only ticket and pr sources",
    ],
    kinds: ['ticket', 'pr'],
  });
});

test("watchProblem finds nothing in an unwatched workflow, or in the fixture's watch on the ticket intake", () => {
  expect(watchProblem(declared({}))).toBeUndefined();
  expect(watchProblem(declared({ watch: { every: '5m' }, maxConcurrentRuns: 2 }))).toBeUndefined();
  expect(watchProblem(declared({}, prOnly as never))).toBeUndefined();
});

test("watchLabel is the watch's own label, then project.yaml's, then sail's", () => {
  const own = declared({ watch: { every: '5m', label: 'review' }, maxConcurrentRuns: 2 });
  const plain = declared({ watch: { every: '5m' }, maxConcurrentRuns: 2 });
  expect(watchLabel(own, { label: 'team' })).toBe('review');
  expect(watchLabel(plain, { label: 'team' })).toBe('team');
  expect(watchLabel(plain, {})).toBe('sail');
});

test('parseEvery refuses an every longer than a timer can wait, and watchProblem names that limit (review #1.4)', () => {
  expect(parseEvery('596h')).toBe(2_145_600_000);
  expect(parseEvery('35791m')).toBe(2_147_460_000);
  expect(parseEvery('597h')).toBeUndefined();
  expect(parseEvery('600h')).toBeUndefined();
  expect(parseEvery('99999999999999999999h')).toBeUndefined();
  expect(watchProblem(declared({ watch: { every: '600h' }, maxConcurrentRuns: 2 }))).toBe(
    'has watch.every "600h", which is longer than 2147483647 ms (about 596h), the longest a timer can wait',
  );
});
