// summary.json: the summary consumer's writes, its seed on a resume, and a rebuild's refusals and race with the run, on
// hand-written events.
// A whole run's summary is runtime.test.ts's.
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rebuildSummary, summaryConsumer, writeSummary } from '../../../src/events/consumers/summary';
import { type Summary, summarize } from '../../../src/events/summary';
import type { SailEvent } from '../../../src/events/types';
import {
  at,
  end,
  journal,
  ndjson,
  produced,
  RUN_ID,
  route,
  runEnd,
  runStart,
  stamp,
  start,
} from '../../helpers/events';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An empty run directory, named for the run. */
function runDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'sail-summary-'));
  dirs.push(root);
  const dir = join(root, RUN_ID);
  mkdirSync(dir);
  return dir;
}

/** The run's summary.json, or undefined when it has none. */
function summaryIn(dir: string): Summary | undefined {
  const path = join(dir, 'summary.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

/** The event `seq` in a run's stream: `type` stamped by the bus, at `ms`. */
const stamped = (seq: number, ms: number, event: Parameters<typeof stamp>[0][1]): SailEvent =>
  ({ seq, ts: at(ms), runId: RUN_ID, ...event }) as SailEvent;

test('the consumer writes summary.json at run:start, each journal:append, run:end and error:crash, and at nothing else', () => {
  const dir = runDir();
  const consumer = summaryConsumer(dir);
  const wrote: string[] = [];
  for (const event of stamp(
    [0, runStart()],
    [100, start('spec#1')],
    [200, produced('spec#1', 'spec.md')],
    [300, end('spec#1', 'passed', 200)],
    [310, journal('spec#1', 1, 'passed')],
    [320, route('spec#1', 'passed', 'implement#1')],
    [330, { type: 'loop:iteration', loop: 'fix', iteration: 1, max: 3 }],
    [400, runEnd('suspended', 1, { stopReason: 'interrupted', message: 'stopped before implement#1' })],
    [450, { type: 'error:consumer', consumer: 'terminal', failed: { seq: 8, type: 'run:end' }, message: 'EPIPE' }],
    [500, start('implement#1')],
    [600, { type: 'error:crash', key: 'implement#1', message: "journal.ndjson:2 can't be read" }],
  )) {
    rmSync(join(dir, 'summary.json'), { force: true });
    consumer.onEvent(event);
    if (existsSync(join(dir, 'summary.json'))) wrote.push(event.type);
  }
  expect(wrote).toEqual(['run:start', 'journal:append', 'run:end', 'error:crash']);
});

/** A first process's events: `spec#1` journaled, then suspended after 2 replays. */
const FIRST_PROCESS = stamp(
  [0, runStart()],
  [100, start('spec#1')],
  [300, end('spec#1', 'passed', 200)],
  [310, journal('spec#1', 1, 'passed')],
  [400, runEnd('suspended', 2, { stopReason: 'interrupted', message: 'stopped before implement#1' })],
);

test('a consumer that joins a resumed run seeds itself from events.ndjson, and counts the event in hand once', () => {
  const dir = runDir();
  // A resume whose replay ends the run at once: its first event is run:end.
  const resumed = stamped(FIRST_PROCESS.length + 1, 900, runEnd('completed', 1));
  // The events file comes first in the bus, so it already holds the event in hand.
  writeFileSync(join(dir, 'events.ndjson'), ndjson([...FIRST_PROCESS, resumed]));
  summaryConsumer(dir).onEvent(resumed);
  expect(summaryIn(dir)).toMatchObject({
    status: 'completed',
    endedAt: at(900),
    calls: [{ key: 'spec#1' }],
    totals: { replays: 3 },
  });
});

test("a seed that can't read events.ndjson throws, and the next event seeds again", () => {
  const dir = runDir();
  const path = join(dir, 'events.ndjson');
  const next = FIRST_PROCESS.length + 1;
  const resumed = [
    stamped(next, 500, start('implement#1')),
    stamped(next + 1, 700, end('implement#1', 'passed', 200)),
    stamped(next + 2, 710, journal('implement#1', 2, 'passed')),
  ];
  const [first, second, third] = resumed as [SailEvent, SailEvent, SailEvent];
  const lines = ndjson([...FIRST_PROCESS, first]).split('\n');
  lines[1] = 'not json';
  writeFileSync(path, lines.join('\n'));
  const consumer = summaryConsumer(dir);
  expect(() => consumer.onEvent(first)).toThrow(/^events\.ndjson:2 can't be read: /);

  writeFileSync(path, ndjson([...FIRST_PROCESS, first, second]));
  consumer.onEvent(second);
  consumer.onEvent(third);
  expect(summaryIn(dir)).toMatchObject({
    status: 'running',
    calls: [{ key: 'spec#1' }, { key: 'implement#1', outcome: 'passed' }],
  });
});

test.each<[string, string, unknown]>([
  [
    'holds no run:start',
    ndjson(stamp([100, start('spec#1')], [300, end('spec#1', 'passed', 200)])),
    `run ${RUN_ID}'s events hold no run:start, so there is no summary to build`,
  ],
  [
    "has a line that can't be read",
    `${ndjson(stamp([0, runStart()]))}not json\n`,
    expect.stringMatching(/^events\.ndjson:2 can't be read: ./),
  ],
])('rebuildSummary refuses events that %s, and writes nothing', (_, events, refused) => {
  const dir = runDir();
  writeFileSync(join(dir, 'events.ndjson'), events);
  expect(rebuildSummary(dir)).toEqual({ refused: refused as string });
  expect(existsSync(join(dir, 'summary.json'))).toBe(false);
});

test("a rebuild that the run's last write overtakes reads on and writes again, so the run's end isn't lost", () => {
  const dir = runDir();
  const path = join(dir, 'events.ndjson');
  const running = stamp(
    [0, runStart()],
    [100, start('spec#1')],
    [300, end('spec#1', 'passed', 200)],
    [310, journal('spec#1', 1, 'passed')],
  );
  const ended = stamped(running.length + 1, 400, runEnd('completed', 1));
  const whole = summarize([...running, ended]) as Summary;
  writeFileSync(path, ndjson(running));
  const statuses: string[] = [];
  const rebuilt = rebuildSummary(dir, (runDir, summary) => {
    if (statuses.length === 0) {
      // The run ends between the rebuild's read and its write: it appends run:end, then writes its own summary.
      appendFileSync(path, ndjson([ended]));
      writeSummary(runDir, whole);
    }
    statuses.push(summary.status);
    return writeSummary(runDir, summary);
  });
  expect([statuses, summaryIn(dir), rebuilt]).toEqual([
    ['running', 'completed'],
    whole,
    { summary: whole, path: join(dir, 'summary.json') },
  ]);
});
