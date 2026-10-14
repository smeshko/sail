// A queue's event stream: numbered without a gap, continued across restarts, and every line a sail.event.v1 event.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openQueueStream, type QueueStream } from '../../src/watch/queue-events';
import { manualClock, queueEventIssues, queueEvents } from '../helpers/queue';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A queue's directory that doesn't exist yet, in a fresh temp dir. */
function queueDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'sail-queue-events-'));
  dirs.push(root);
  return join(root, 'queue', 'ticket-to-pr');
}

const clock = manualClock('2026-10-14T09:00:00.000Z');

function open(dir: string): QueueStream {
  const stream = openQueueStream(dir, clock);
  if ('refused' in stream) throw new Error(stream.refused);
  return stream;
}

const polled = (added: number) =>
  ({
    type: 'queue:polled',
    workflow: 'ticket-to-pr',
    kind: 'ticket',
    label: 'sail',
    found: 3,
    added,
    durationMs: 5,
  }) as const;

test('a new stream writes seq 1, 2 and 3 as valid events, and reopened it continues at 4', () => {
  const dir = queueDir();
  const stream = open(dir);
  expect([3, 0, 0].map((added) => stream.emit(polled(added)).seq)).toEqual([1, 2, 3]);
  expect(open(dir).emit(polled(0))).toEqual({ seq: 4, ts: '2026-10-14T09:00:00.000Z', ...polled(0) });
  expect(queueEvents(dir).map((event) => [event.seq, event.added])).toEqual([
    [1, 3],
    [2, 0],
    [3, 0],
    [4, 0],
  ]);
  expect(queueEventIssues(dir)).toEqual([]);
});

test('a torn last line is cut, and the stream continues after the last whole line', () => {
  const dir = queueDir();
  mkdirSync(dir, { recursive: true });
  const whole = (seq: number) => JSON.stringify({ seq, ts: '2026-10-14T09:00:00.000Z', ...polled(1) });
  writeFileSync(join(dir, 'events.ndjson'), `${whole(1)}\n${whole(2)}\n{"seq":3,"ts":"2026-`);
  expect(open(dir).emit(polled(0)).seq).toBe(3);
  expect(readFileSync(join(dir, 'events.ndjson'), 'utf8')).toBe(
    `${whole(1)}\n${whole(2)}\n${JSON.stringify({ seq: 3, ts: '2026-10-14T09:00:00.000Z', ...polled(0) })}\n`,
  );
});

test('a last line that is no event refuses, naming its line, and leaves the file as it was', () => {
  const dir = queueDir();
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify({ seq: 1, ts: '2026-10-14T09:00:00.000Z', ...polled(1) })}\nnot json\n`;
  writeFileSync(join(dir, 'events.ndjson'), text);
  expect(openQueueStream(dir, clock)).toEqual({
    refused: expect.stringMatching(/^events\.ndjson:2 can't be read, so the events can't continue: ./),
  });
  expect(readFileSync(join(dir, 'events.ndjson'), 'utf8')).toBe(text);
});
