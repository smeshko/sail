// The watcher's terminal lines (DECISIONS D18): one per queue event, settled item, error and watch-set change, as
// `<HH:MM:SS> <workflow>  <what>`, cleaned of whatever a provider's text holds, and coloured only on a terminal.
import { expect, test } from 'bun:test';
import { validateDocument } from '../../src/engine/schemas';
import type { QueueEvent } from '../../src/events/types';
import { errorLine, formatLines, queueLine, setLine, settledLine } from '../../src/watch/lines';

const TS = '2026-10-15T08:09:10.000Z';
const AT = new Date(TS);
const RUN = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const envelope = { seq: 1, ts: TS, workflow: 'a' };
const utc = formatLines({ timeZone: 'UTC' });
const TTY = { columns: () => 120 };

/** A sample of each queue event type, and its line's text. */
const SAMPLES: [QueueEvent, string][] = [
  [
    { ...envelope, type: 'watch:added', pid: 4242, label: 'sail', everyMs: 30_000, maxConcurrentRuns: 2 },
    'watching: label sail, every 30.0s, at most 2 at once',
  ],
  [{ ...envelope, type: 'watch:removed', pid: 4242 }, 'unwatched'],
  [
    { ...envelope, type: 'queue:polled', kind: 'ticket', label: 'sail', found: 3, added: 2, durationMs: 12 },
    'polled sail: 3 found, 2 queued',
  ],
  [
    {
      ...envelope,
      type: 'queue:item_added',
      dedupKey: 'ticket:FAKE-1',
      source: { kind: 'ticket', ticketKey: 'FAKE-1' },
      title: 'Add a greeting',
    },
    'FAKE-1 queued: Add a greeting',
  ],
  [
    { ...envelope, type: 'queue:dispatched', dedupKey: 'ticket:FAKE-1', run: RUN, attempt: 1, pid: 4243 },
    `FAKE-1 dispatched as run ${RUN}, attempt 1, pid 4243`,
  ],
  [
    {
      ...envelope,
      type: 'queue:skipped_leased',
      dedupKey: 'ticket:FAKE-3',
      branch: 'sail/FAKE-3-docs',
      heldBy: RUN,
    },
    `FAKE-3 waits: its branch sail/FAKE-3-docs is leased by run ${RUN}`,
  ],
  [
    { ...envelope, type: 'queue:dropped', dedupKey: 'ticket:FAKE-4', reason: 'it is In Progress' },
    'FAKE-4 dropped: it is In Progress',
  ],
  [
    { ...envelope, type: 'queue:parked', dedupKey: 'ticket:FAKE-2', attempts: 2, reason: 'spec blocked' },
    'FAKE-2 parked after 2 attempts: spec blocked',
  ],
  [
    {
      ...envelope,
      type: 'queue:error',
      port: 'ticketSource',
      adapter: 'linear',
      code: 'unauthorized',
      message: 'ticketSource.listDesignated: key expired',
      paused: true,
    },
    'error: linear unauthorized: ticketSource.listDesignated: key expired; polling paused',
  ],
  [
    {
      ...envelope,
      type: 'queue:error',
      port: 'ticketSource',
      adapter: 'linear',
      message: 'ticketSource.listDesignated: socket hang up',
      paused: false,
      retryInMs: 120_000,
    },
    'error: linear: ticketSource.listDesignated: socket hang up; next poll in 2m 0s',
  ],
];

test.each(SAMPLES.map(([event, text]) => [event.type, event, text] as const))(
  '%s prints its line, and its sample is a valid queue event',
  (_, event, text) => {
    expect(validateDocument('sail.event.v1', event)).toEqual([]);
    const line = queueLine(event);
    expect(line === undefined ? undefined : utc(line)).toBe(`08:09:10 a  ${text}\n`);
  },
);

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('run:adopted, run:resumed from running and from suspended, and queue:requeued each print their line', () => {
  const events: QueueEvent[] = [
    { ...envelope, type: 'run:adopted', dedupKey: 'ticket:FAKE-1', run: RUN, pid: 4243 },
    { ...envelope, type: 'run:resumed', dedupKey: 'ticket:FAKE-1', run: RUN, pid: 4244, from: { status: 'running' } },
    {
      ...envelope,
      type: 'run:resumed',
      dedupKey: 'ticket:FAKE-1',
      run: RUN,
      pid: 4245,
      from: { status: 'suspended', stopReason: 'unwatched' },
    },
    { ...envelope, type: 'queue:requeued', dedupKey: 'ticket:FAKE-2', reason: 'requeued by hand' },
  ];
  expect(
    events.map((event) => {
      const line = queueLine(event);
      return line === undefined ? undefined : utc(line);
    }),
  ).toEqual([
    `08:09:10 a  FAKE-1 adopted: run ${RUN}, pid 4243\n`,
    `08:09:10 a  FAKE-1 resumed: run ${RUN} (was running), pid 4244\n`,
    `08:09:10 a  FAKE-1 resumed: run ${RUN} (was suspended unwatched), pid 4245\n`,
    '08:09:10 a  FAKE-2 requeued: requeued by hand\n',
  ]);
});

test('a poll that found nothing prints no line, unless it follows a failed poll', () => {
  const nothing: QueueEvent = {
    ...envelope,
    type: 'queue:polled',
    kind: 'ticket',
    label: 'sail',
    found: 0,
    added: 0,
    durationMs: 3,
  };
  const after = queueLine(nothing, true);
  expect([queueLine(nothing), after === undefined ? undefined : utc(after)]).toEqual([
    undefined,
    '08:09:10 a  polled sail: 0 found, 0 queued\n',
  ]);
});

test('a title holding an escape, a carriage return and a newline prints as one line with no escape', () => {
  const line = queueLine({
    ...envelope,
    type: 'queue:item_added',
    dedupKey: 'ticket:FAKE-1',
    source: { kind: 'ticket', ticketKey: 'FAKE-1' },
    title: 'Red \x1b[31malert\x1b[0m\rover\nnext',
  });
  expect(line === undefined ? undefined : utc(line)).toBe('08:09:10 a  FAKE-1 queued: Red alert over next\n');
});

test('piped, a line has no escape byte; on a terminal the time is dim and an error line red', () => {
  const coloured = formatLines({ timeZone: 'UTC', tty: TTY });
  const error = errorLine('a', new Error('the disk is full'), AT);
  const set = setLine(['a', 'b'], AT);
  expect([utc(error), utc(set)]).toEqual(['08:09:10 a  error: the disk is full\n', '08:09:10 watch set: a, b\n']);
  expect([coloured(error), coloured(set)]).toEqual([
    '\x1b[2m08:09:10\x1b[0m a  \x1b[31merror: the disk is full\x1b[0m\n',
    '\x1b[2m08:09:10\x1b[0m watch set: a, b\n',
  ]);
});

test('the time is local unless a time zone is given: the same instant in UTC and in Tokyo', () => {
  const line = setLine([], AT);
  expect([utc(line), formatLines({ timeZone: 'Asia/Tokyo' })(line)]).toEqual([
    '08:09:10 watch set: empty; the watcher stops\n',
    '17:09:10 watch set: empty; the watcher stops\n',
  ]);
});

test('a settled item prints done or when it is due again, and a parked one leaves its line to queue:parked', () => {
  const base = { dedupKey: 'ticket:FAKE-1', ticketKey: 'FAKE-1', runId: RUN };
  const done = settledLine('a', { ...base, outcome: 'done' }, AT);
  const retry = settledLine(
    'a',
    { ...base, outcome: 'retry', reason: `run ${RUN} failed (stage_error)`, retryAt: '2026-10-15T08:14:10.000Z' },
    AT,
  );
  const parked = settledLine('a', { ...base, outcome: 'parked', reason: 'spec blocked' }, AT);
  expect([done && utc(done), retry && utc(retry), parked]).toEqual([
    `08:09:10 a  FAKE-1 done: run ${RUN} completed\n`,
    `08:09:10 a  FAKE-1 failed: run ${RUN} failed (stage_error); due again in 5m 0s\n`,
    undefined,
  ]);
});
