// The event bus: stamping, synchronous fan-out, and a consumer that throws reported as an event of its own.
import { expect, test } from 'bun:test';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import { createBus } from '../../src/events/bus';
import type { Consumer, NewEvent, SailEvent } from '../../src/events/types';

const RUN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const TS = '2026-09-28T09:00:00.000Z';
const now = () => new Date(TS);

const stageStart: NewEvent = {
  type: 'stage:start',
  stage: 'tests',
  call: 1,
  try: 1,
  kind: 'script',
  consumed: {},
  key: 'tests#1',
};
const iteration: NewEvent = { type: 'loop:iteration', loop: 'fix', iteration: 1, max: 3 };

/** A consumer that records `<name> <type> #<seq>` in `log` for each event it receives, then runs `then`. */
function recorder(name: string, log: string[], then: (event: SailEvent) => void = () => undefined): Consumer {
  return {
    name,
    onEvent(event) {
      log.push(`${name} ${event.type} #${event.seq}`);
      then(event);
    },
  };
}

/** A consumer that keeps every event it receives. */
function keeper(): Consumer & { events: SailEvent[] } {
  const events: SailEvent[] = [];
  return { name: 'keeper', events, onEvent: (event) => events.push(event) };
}

const issues = (events: SailEvent[]) =>
  events.flatMap((event) => validateDocument('sail.event.v1', event)).map(formatIssue);

test('events are numbered from firstSeq, stamped with ts and runId, and keep their key and payload', () => {
  const kept = keeper();
  const bus = createBus({ runId: RUN_ID, firstSeq: 5, consumers: [kept], now });
  const first = bus.emit(stageStart);
  const second = bus.emit(iteration);

  expect(JSON.stringify(first)).toBe(
    `{"seq":5,"ts":"${TS}","type":"stage:start","runId":"${RUN_ID}","key":"tests#1","stage":"tests","call":1,"try":1,"kind":"script","consumed":{}}`,
  );
  expect(JSON.stringify(second)).toBe(
    `{"seq":6,"ts":"${TS}","type":"loop:iteration","runId":"${RUN_ID}","loop":"fix","iteration":1,"max":3}`,
  );
  expect(kept.events).toEqual([first, second]);
  expect(issues(kept.events)).toEqual([]);
});

test('every consumer receives each event, in the order they were given, before emit returns', () => {
  const log: string[] = [];
  const bus = createBus({ runId: RUN_ID, firstSeq: 1, consumers: [recorder('a', log), recorder('b', log)], now });
  bus.emit(stageStart);
  expect(log).toEqual(['a stage:start #1', 'b stage:start #1']);
  bus.emit(iteration);
  expect(log).toEqual(['a stage:start #1', 'b stage:start #1', 'a loop:iteration #2', 'b loop:iteration #2']);
});

test('a consumer that throws is reported as error:consumer at the next seq, to every consumer, once all have the event', () => {
  const log: string[] = [];
  const kept = keeper();
  const flaky = recorder('flaky', log, (event) => {
    if (event.type === 'stage:start') throw new Error('boom');
  });
  const bus = createBus({
    runId: RUN_ID,
    firstSeq: 1,
    consumers: [recorder('a', log), flaky, recorder('b', log), kept],
    now,
  });

  const emitted = bus.emit(stageStart);
  expect(emitted).toMatchObject({ seq: 1, type: 'stage:start' });
  expect(log).toEqual([
    'a stage:start #1',
    'flaky stage:start #1',
    'b stage:start #1',
    'a error:consumer #2',
    'flaky error:consumer #2',
    'b error:consumer #2',
  ]);
  expect(kept.events[1]).toEqual({
    seq: 2,
    ts: TS,
    type: 'error:consumer',
    runId: RUN_ID,
    consumer: 'flaky',
    failed: { seq: 1, type: 'stage:start' },
    message: 'boom',
  });
  expect(bus.emit(iteration).seq).toBe(3);
  expect(issues(kept.events)).toEqual([]);
});

test("each consumer's throw is reported in turn, and a thrown non-Error by its String()", () => {
  const kept = keeper();
  const throws = (name: string, thrown: unknown): Consumer => ({
    name,
    onEvent(event) {
      if (event.type === 'stage:start') throw thrown;
    },
  });
  const bus = createBus({
    runId: RUN_ID,
    firstSeq: 1,
    consumers: [throws('x', new Error('disk full')), throws('y', 42), kept],
    now,
  });
  bus.emit(stageStart);
  expect(kept.events.map((event) => `${event.type} #${event.seq}`)).toEqual([
    'stage:start #1',
    'error:consumer #2',
    'error:consumer #3',
  ]);
  expect(kept.events.slice(1)).toMatchObject([
    { consumer: 'x', failed: { seq: 1, type: 'stage:start' }, message: 'disk full' },
    { consumer: 'y', failed: { seq: 1, type: 'stage:start' }, message: '42' },
  ]);
});

test('a consumer that throws on an error:consumer reaches unreported, and nothing more is emitted', () => {
  const kept = keeper();
  const unreported: [string, string, number, string][] = [];
  const always: Consumer = {
    name: 'always',
    onEvent() {
      throw new Error('still broken');
    },
  };
  const bus = createBus({
    runId: RUN_ID,
    firstSeq: 1,
    consumers: [kept, always],
    now,
    unreported: (error, consumer, event) =>
      unreported.push([(error as Error).message, consumer.name, event.seq, event.type]),
  });

  expect(() => bus.emit(stageStart)).not.toThrow();
  expect(kept.events.map((event) => `${event.type} #${event.seq}`)).toEqual(['stage:start #1', 'error:consumer #2']);
  expect(unreported).toEqual([['still broken', 'always', 2, 'error:consumer']]);
  expect(bus.emit(iteration).seq).toBe(3);
});

test('by default, a throw on an error:consumer is written to stderr as one line', () => {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const always: Consumer = {
      name: 'always',
      onEvent() {
        throw new Error('disk full');
      },
    };
    createBus({ runId: RUN_ID, firstSeq: 1, consumers: [always], now }).emit(stageStart);
  } finally {
    process.stderr.write = write;
  }
  expect(written).toEqual(['sail: consumer always failed on error:consumer #2: disk full\n']);
});

test('an event emitted during delivery waits until every consumer has the one being delivered', () => {
  const log: string[] = [];
  const bus = createBus({
    runId: RUN_ID,
    firstSeq: 1,
    consumers: [
      recorder('echo', log, (event) => {
        if (event.type === 'stage:start') bus.emit(iteration);
      }),
      recorder('flaky', log, (event) => {
        if (event.type === 'stage:start') throw new Error('boom');
      }),
      recorder('b', log),
    ],
    now,
  });

  expect(bus.emit(stageStart).seq).toBe(1);
  expect(log).toEqual([
    'echo stage:start #1',
    'flaky stage:start #1',
    'b stage:start #1',
    'echo loop:iteration #2',
    'flaky loop:iteration #2',
    'b loop:iteration #2',
    'echo error:consumer #3',
    'flaky error:consumer #3',
    'b error:consumer #3',
  ]);
});

test('emit never throws: not on a thrown value String() rejects, nor when unreported throws', () => {
  const kept = keeper();
  const odd: Consumer = {
    name: 'odd',
    onEvent() {
      throw Object.create(null);
    },
  };
  const bus = createBus({
    runId: RUN_ID,
    firstSeq: 1,
    consumers: [odd, kept],
    now,
    unreported: () => {
      throw new Error('stderr is gone');
    },
  });

  expect(() => bus.emit(stageStart)).not.toThrow();
  expect(kept.events[1]).toMatchObject({
    seq: 2,
    type: 'error:consumer',
    consumer: 'odd',
    message: "a thrown value String() can't convert",
  });
  expect(() => bus.emit(iteration)).not.toThrow();
  expect(kept.events.map((event) => `${event.type} #${event.seq}`)).toEqual([
    'stage:start #1',
    'error:consumer #2',
    'loop:iteration #3',
    'error:consumer #4',
  ]);
});

test("the bus owns the envelope: an open payload's seq, ts and runId don't replace it", () => {
  const bus = createBus({ runId: RUN_ID, firstSeq: 1, consumers: [], now });
  const emitted = bus.emit({
    type: 'codehost:checks',
    seq: 99,
    ts: 'yesterday',
    runId: 'someone-else',
    state: 'green',
  });
  expect(JSON.stringify(emitted)).toBe(
    `{"seq":1,"ts":"${TS}","type":"codehost:checks","runId":"${RUN_ID}","state":"green"}`,
  );
});
