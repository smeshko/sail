// events.ndjson: created with the run, one appended line per event, and where a resumed run's numbering continues.
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEventsFile,
  type EventCursor,
  ndjsonConsumer,
  nextSeq,
  readEvents,
  readEventsFrom,
  START,
} from '../../../src/events/consumers/ndjson';
import type { SailEvent } from '../../../src/events/types';

const RUN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-events-'));
  dirs.push(dir);
  return dir;
}

/** `events.ndjson` in `dir`, or undefined when there is none. */
function contents(dir: string): string | undefined {
  const path = join(dir, 'events.ndjson');
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** The `seq`th event of a run: a call's start, with a payload a line can hold. */
const event = (seq: number): SailEvent => ({
  seq,
  ts: `2026-09-28T09:00:0${seq}.000Z`,
  type: 'stage:start',
  runId: RUN_ID,
  key: `tests#${seq}`,
  stage: 'tests',
  call: seq,
  try: 1,
  kind: 'script',
  consumed: { note: 'a "quoted"\nvalue' },
});

const lines = (...seqs: number[]) => seqs.map((seq) => `${JSON.stringify(event(seq))}\n`).join('');

test('createEventsFile creates an empty events.ndjson, and a second call throws EEXIST', () => {
  const dir = runDir();
  createEventsFile(dir);
  expect(contents(dir)).toBe('');
  expect(() => createEventsFile(dir)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
});

test('each event is appended as one line, and the lines before it never change', () => {
  const dir = runDir();
  createEventsFile(dir);
  const consumer = ndjsonConsumer(dir);
  let before = '';
  for (const seq of [1, 2, 3]) {
    consumer.onEvent(event(seq));
    const after = contents(dir) ?? '';
    expect(after).toBe(`${before}${JSON.stringify(event(seq))}\n`);
    expect(JSON.parse(after.trimEnd().split('\n').at(-1) ?? '')).toEqual(event(seq));
    before = after;
  }
});

test('the consumer creates a missing events file on its first event, as for a run opened before events', () => {
  const dir = runDir();
  ndjsonConsumer(dir).onEvent(event(1));
  expect(contents(dir)).toBe(lines(1));
});

test('a write that fails throws, for the bus to report', () => {
  const dir = runDir();
  const consumer = ndjsonConsumer(dir);
  rmSync(dir, { recursive: true });
  expect(() => consumer.onEvent(event(1))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
});

test.skipIf(process.getuid?.() === 0)(
  'a line a write failed on goes ahead of the next event, once what that write left is cut, so no seq is missing',
  () => {
    const dir = runDir();
    createEventsFile(dir);
    const path = join(dir, 'events.ndjson');
    const consumer = ndjsonConsumer(dir);
    consumer.onEvent(event(1));
    chmodSync(path, 0o444);
    expect(() => consumer.onEvent(event(2))).toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect(() => consumer.onEvent(event(3))).toThrow(expect.objectContaining({ code: 'EACCES' }));
    chmodSync(path, 0o644);
    appendFileSync(path, JSON.stringify(event(2)).slice(0, 30)); // what a write that failed part way leaves
    consumer.onEvent(event(4));
    expect(contents(dir)).toBe(lines(1, 2, 3, 4));
  },
);

test("nextSeq is 1 for a missing or empty file, and one past the last line's seq otherwise", () => {
  const dir = runDir();
  expect(nextSeq(dir)).toBe(1);
  writeFileSync(join(dir, 'events.ndjson'), '');
  expect(nextSeq(dir)).toBe(1);
  writeFileSync(join(dir, 'events.ndjson'), lines(1, 2, 3));
  expect(nextSeq(dir)).toBe(4);
});

test('nextSeq cuts a torn tail, and continues from the last complete line', () => {
  const dir = runDir();
  const torn = JSON.stringify(event(4)).slice(0, 40);
  writeFileSync(join(dir, 'events.ndjson'), `${lines(1, 2, 3)}${torn}`);
  expect(nextSeq(dir)).toBe(4);
  expect(contents(dir)).toBe(lines(1, 2, 3));

  writeFileSync(join(dir, 'events.ndjson'), torn);
  expect(nextSeq(dir)).toBe(1);
  expect(contents(dir)).toBe('');
});

test.each<[string, string]>([
  ['is not JSON', '{ not json'],
  ['has no whole seq', JSON.stringify({ ...event(3), seq: '3' })],
])('nextSeq refuses a last line that %s, naming it, and leaves the file as it was', (_, last) => {
  const dir = runDir();
  writeFileSync(join(dir, 'events.ndjson'), lines(1, 2));
  appendFileSync(join(dir, 'events.ndjson'), `${last}\n`);
  const before = contents(dir);
  expect(nextSeq(dir)).toEqual({
    refused: expect.stringMatching(/^events\.ndjson:3 can't be read, so the events can't continue: ./),
  });
  expect(contents(dir)).toBe(before);
});

test('readEvents gives every event of a run in file order, and none for a missing file', () => {
  const fake1 = join(import.meta.dir, '..', '..', 'fixtures', 'runs', RUN_ID);
  const events = readEvents(fake1);
  expect(events.map((each) => each.seq)).toEqual(Array.from({ length: 131 }, (_, index) => index + 1));
  const last = readFileSync(join(fake1, 'events.ndjson'), 'utf8').trimEnd().split('\n').at(-1) ?? '';
  expect(events.at(-1)).toEqual(JSON.parse(last));
  expect(readEvents(runDir())).toEqual([]);
});

test('readEvents skips a torn tail and every line that is not an event, and leaves the file as it was', () => {
  const dir = runDir();
  const junk = ['{ not json', 'null', '["seq",3]', '{"seq":"3","type":"stage:start"}', '{"seq":3}'];
  const text = `${lines(1, 2)}${junk.join('\n')}\n${lines(3)}${JSON.stringify(event(4)).slice(0, 40)}`;
  writeFileSync(join(dir, 'events.ndjson'), text);
  expect(readEvents(dir)).toEqual([event(1), event(2), event(3)]);
  expect(contents(dir)).toBe(text);
});

test("readEvents skips a line that doesn't match sail.event.v1, such as a run:end without its replays", () => {
  const dir = runDir();
  const end = { seq: 3, ts: '2026-09-28T09:00:03.000Z', type: 'run:end', runId: RUN_ID, status: 'completed' };
  writeFileSync(join(dir, 'events.ndjson'), `${lines(1, 2)}${JSON.stringify(end)}\n${lines(4)}`);
  expect(readEvents(dir)).toEqual([event(1), event(2), event(4)]);
});

test("nextSeq refuses before it cuts: a torn tail after a line it can't read stays", () => {
  const dir = runDir();
  writeFileSync(join(dir, 'events.ndjson'), `${lines(1, 2)}{ not json\n${JSON.stringify(event(4)).slice(0, 40)}`);
  const before = contents(dir);
  expect(nextSeq(dir)).toEqual({
    refused: expect.stringMatching(/^events\.ndjson:3 can't be read, so the events can't continue: ./),
  });
  expect(contents(dir)).toBe(before);
});

/** Where a read left off, or the start when it refused. */
const nextOf = (read: ReturnType<typeof readEventsFrom>): EventCursor => ('next' in read ? read.next : START);

const bytes = (text: string) => Buffer.byteLength(text);

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('readEventsFrom gives nothing for a missing file, then every event once it is written, with next at its end', () => {
  const dir = runDir();
  expect(readEventsFrom(dir, { offset: 5, line: 1 })).toEqual({ events: [], next: { offset: 5, line: 1 } });
  writeFileSync(join(dir, 'events.ndjson'), lines(1, 2, 3));
  expect(readEventsFrom(dir)).toEqual({
    events: [event(1), event(2), event(3)],
    next: { offset: bytes(lines(1, 2, 3)), line: 3 },
  });
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('reading from next gives only the lines appended since, numbered on', () => {
  const dir = runDir();
  writeFileSync(join(dir, 'events.ndjson'), lines(1, 2));
  const first = readEventsFrom(dir);
  appendFileSync(join(dir, 'events.ndjson'), lines(3, 4));
  expect(readEventsFrom(dir, nextOf(first))).toEqual({
    events: [event(3), event(4)],
    next: { offset: bytes(lines(1, 2, 3, 4)), line: 4 },
  });
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a torn tail waits for the next read, which gives its line whole once it is complete', () => {
  const dir = runDir();
  const path = join(dir, 'events.ndjson');
  const torn = JSON.stringify(event(2));
  writeFileSync(path, `${lines(1)}${torn.slice(0, 40)}`);
  const first = readEventsFrom(dir);
  appendFileSync(path, `${torn.slice(40)}\n`);
  expect([first, readEventsFrom(dir, nextOf(first))]).toEqual([
    { events: [event(1)], next: { offset: bytes(lines(1)), line: 1 } },
    { events: [event(2)], next: { offset: bytes(lines(1, 2)), line: 2 } },
  ]);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  .each(['é', '✓'])('a line whose %s is split across two appends is read whole', (char) => {
  const dir = runDir();
  const path = join(dir, 'events.ndjson');
  const written = { ...event(1), consumed: { note: `before ${char} after` } } as SailEvent;
  const line = Buffer.from(`${JSON.stringify(written)}\n`);
  const inside = line.indexOf(Buffer.from(char)) + 1;
  writeFileSync(path, line.subarray(0, inside));
  const first = readEventsFrom(dir);
  appendFileSync(path, line.subarray(inside));
  expect([first, readEventsFrom(dir, nextOf(first))]).toEqual([
    { events: [], next: START },
    { events: [written], next: { offset: line.length, line: 1 } },
  ]);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  .each<[string, string]>([
  ['is not JSON', '{ not json'],
  ['has no whole seq', JSON.stringify({ ...event(3), seq: '3' })],
  ['has no type', JSON.stringify({ seq: 3, ts: '2026-09-28T09:00:03.000Z', runId: RUN_ID })],
])('readEventsFrom refuses a line that %s, numbering it across reads', (_, bad) => {
  const dir = runDir();
  writeFileSync(join(dir, 'events.ndjson'), lines(1, 2));
  const first = readEventsFrom(dir);
  appendFileSync(join(dir, 'events.ndjson'), `${bad}\n`);
  expect(readEventsFrom(dir, nextOf(first))).toEqual({
    refused: expect.stringMatching(/^events\.ndjson:3 can't be read: ./),
  });
});
