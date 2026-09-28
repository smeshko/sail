// events.ndjson: created with the run, one appended line per event, and where a resumed run's numbering continues.
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventsFile, ndjsonConsumer, nextSeq } from '../../../src/events/consumers/ndjson';
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

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('createEventsFile creates an empty events.ndjson, and a second call throws EEXIST', () => {
    const dir = runDir();
    createEventsFile(dir);
    expect(contents(dir)).toBe('');
    expect(() => createEventsFile(dir)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
  });

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('each event is appended as one line, and the lines before it never change', () => {
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

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('the consumer creates a missing events file on its first event, as for a run opened before events', () => {
    const dir = runDir();
    ndjsonConsumer(dir).onEvent(event(1));
    expect(contents(dir)).toBe(lines(1));
  });

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a write that fails throws, for the bus to report', () => {
    const dir = runDir();
    const consumer = ndjsonConsumer(dir);
    rmSync(dir, { recursive: true });
    expect(() => consumer.onEvent(event(1))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ("nextSeq is 1 for a missing or empty file, and one past the last line's seq otherwise", () => {
    const dir = runDir();
    expect(nextSeq(dir)).toBe(1);
    writeFileSync(join(dir, 'events.ndjson'), '');
    expect(nextSeq(dir)).toBe(1);
    writeFileSync(join(dir, 'events.ndjson'), lines(1, 2, 3));
    expect(nextSeq(dir)).toBe(4);
  });

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('nextSeq cuts a torn tail, and continues from the last complete line', () => {
    const dir = runDir();
    const torn = JSON.stringify(event(4)).slice(0, 40);
    writeFileSync(join(dir, 'events.ndjson'), `${lines(1, 2, 3)}${torn}`);
    expect(nextSeq(dir)).toBe(4);
    expect(contents(dir)).toBe(lines(1, 2, 3));

    writeFileSync(join(dir, 'events.ndjson'), torn);
    expect(nextSeq(dir)).toBe(1);
    expect(contents(dir)).toBe('');
  });

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  .each<[string, string]>([
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
