// The queue store: one writer of queue.json per watched workflow, deduplicating by key, counting attempts and parking.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedupKey, openQueue, type QueuePolicy, type QueueStore, queueDir } from '../../src/watch/queue-store';
import { manualClock, queueEventIssues, queueEvents, ticket } from '../helpers/queue';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh `.sail-runs/` in a temp dir. */
function runsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-queue-store-'));
  dirs.push(dir);
  return dir;
}

const START = '2026-10-14T09:00:00.000Z';
const POLICY: QueuePolicy = { maxAttempts: 2, retryDelaysMs: [60_000], pollBackoffMs: [60_000], doneKept: 2 };

function open(runs: string, now = manualClock(START), workflow = 'ticket-to-pr'): QueueStore {
  const store = openQueue({ runsDir: runs, workflow, label: 'sail', now, policy: POLICY });
  if ('refused' in store) throw new Error(store.refused);
  return store;
}

const keys = (store: QueueStore) => store.snapshot().items.map((item) => `${item.dedupKey} ${item.state}`);
const typesIn = (runs: string, workflow = 'ticket-to-pr') =>
  queueEvents(queueDir(runs, workflow)).map((event) => event.type);

test('dedupKey is ticket:<ticket key>', () => {
  expect(dedupKey({ kind: 'ticket', ticketKey: 'FAKE-12' })).toBe('ticket:FAKE-12');
});

test('add queues each new ticket once, with its event, and a second add of the same tickets adds nothing', () => {
  const runs = runsDir();
  const store = open(runs);
  expect(store.add([ticket('FAKE-1'), ticket('FAKE-5')])).toBe(2);
  expect(store.snapshot().items).toEqual([
    {
      dedupKey: 'ticket:FAKE-1',
      source: { kind: 'ticket', ticketKey: 'FAKE-1' },
      title: 'Ticket FAKE-1',
      url: 'fake://tickets/FAKE-1',
      state: 'queued',
      attempts: 0,
      addedAt: START,
    },
    {
      dedupKey: 'ticket:FAKE-5',
      source: { kind: 'ticket', ticketKey: 'FAKE-5' },
      title: 'Ticket FAKE-5',
      url: 'fake://tickets/FAKE-5',
      state: 'queued',
      attempts: 0,
      addedAt: START,
    },
  ]);
  expect(store.add([ticket('FAKE-5'), ticket('FAKE-1')])).toBe(0);
  expect(queueEvents(queueDir(runs, 'ticket-to-pr')).map(({ seq, ts, ...event }) => event)).toEqual([
    {
      type: 'queue:item_added',
      workflow: 'ticket-to-pr',
      dedupKey: 'ticket:FAKE-1',
      source: { kind: 'ticket', ticketKey: 'FAKE-1' },
      title: 'Ticket FAKE-1',
    },
    {
      type: 'queue:item_added',
      workflow: 'ticket-to-pr',
      dedupKey: 'ticket:FAKE-5',
      source: { kind: 'ticket', ticketKey: 'FAKE-5' },
      title: 'Ticket FAKE-5',
    },
  ]);
  expect(queueEventIssues(queueDir(runs, 'ticket-to-pr'))).toEqual([]);
});

test('a key that is dispatched, failed or parked is not queued again, and a done one is queued anew with no attempts', () => {
  const runs = runsDir();
  const clock = manualClock(START);
  const store = open(runs, clock);
  store.add([ticket('FAKE-1'), ticket('FAKE-2'), ticket('FAKE-3'), ticket('FAKE-4')]);
  for (const key of ['ticket:FAKE-1', 'ticket:FAKE-2', 'ticket:FAKE-3', 'ticket:FAKE-4']) store.dispatched(key, 'run');
  store.failed('ticket:FAKE-2', 'tests failed');
  store.dispatched('ticket:FAKE-3', 'run');
  store.failed('ticket:FAKE-3', 'tests failed');
  store.done('ticket:FAKE-4');
  expect(keys(store)).toEqual([
    'ticket:FAKE-1 dispatched',
    'ticket:FAKE-2 failed',
    'ticket:FAKE-3 parked',
    'ticket:FAKE-4 done',
  ]);
  clock.advance(1_000);
  expect(store.add([ticket('FAKE-1'), ticket('FAKE-2'), ticket('FAKE-3'), ticket('FAKE-4')])).toBe(1);
  expect(keys(store)).toEqual([
    'ticket:FAKE-1 dispatched',
    'ticket:FAKE-2 failed',
    'ticket:FAKE-3 parked',
    'ticket:FAKE-4 queued',
  ]);
  expect(store.snapshot().items[3]).toMatchObject({ attempts: 0, addedAt: '2026-10-14T09:00:01.000Z' });
  expect(store.snapshot().items[3]?.finishedAt).toBeUndefined();
  expect(typesIn(runs).filter((type) => type === 'queue:item_added')).toHaveLength(5);
});

test('a failed attempt retries after its delay, and the last attempt parks the item with its reason, never due again', () => {
  const runs = runsDir();
  const clock = manualClock(START);
  const store = open(runs, clock);
  store.add([ticket('FAKE-1')]);
  store.dispatched('ticket:FAKE-1', 'FAKE-1-01');
  expect(store.failed('ticket:FAKE-1', 'tests failed')).toBe('retry');
  expect(store.snapshot().items[0]).toMatchObject({
    state: 'failed',
    attempts: 1,
    retryAt: '2026-10-14T09:01:00.000Z',
    reason: 'tests failed',
    runId: 'FAKE-1-01',
  });
  clock.advance(59_999);
  expect(store.due()).toEqual([]);
  clock.advance(1);
  expect(store.due().map((item) => item.dedupKey)).toEqual(['ticket:FAKE-1']);

  store.dispatched('ticket:FAKE-1', 'FAKE-1-02');
  expect(store.failed('ticket:FAKE-1', 'spec blocked: no acceptance criteria')).toBe('parked');
  expect(store.snapshot().items[0]).toMatchObject({
    state: 'parked',
    attempts: 2,
    reason: 'spec blocked: no acceptance criteria',
  });
  clock.advance(365 * 24 * 3_600_000);
  expect(store.due()).toEqual([]);
  const parked = queueEvents(queueDir(runs, 'ticket-to-pr')).filter((event) => event.type === 'queue:parked');
  expect(parked.map(({ seq, ts, ...event }) => event)).toEqual([
    {
      type: 'queue:parked',
      workflow: 'ticket-to-pr',
      dedupKey: 'ticket:FAKE-1',
      attempts: 2,
      reason: 'spec blocked: no acceptance criteria',
    },
  ]);
  expect(queueEventIssues(queueDir(runs, 'ticket-to-pr'))).toEqual([]);
});

test('a done item is never due, and only the last doneKept items to finish are kept', () => {
  const clock = manualClock(START);
  const store = open(runsDir(), clock);
  store.add([ticket('FAKE-1'), ticket('FAKE-2'), ticket('FAKE-3'), ticket('FAKE-4')]);
  for (const key of ['ticket:FAKE-2', 'ticket:FAKE-1', 'ticket:FAKE-3']) {
    store.dispatched(key, 'run');
    store.done(key);
    clock.advance(1_000);
  }
  expect(keys(store)).toEqual(['ticket:FAKE-1 done', 'ticket:FAKE-3 done', 'ticket:FAKE-4 queued']);
  expect(store.snapshot().items[0]?.finishedAt).toBe('2026-10-14T09:00:01.000Z');
  expect(store.due().map((item) => item.dedupKey)).toEqual(['ticket:FAKE-4']);
});

test('due holds queued items and failed ones past their retryAt, oldest added first', () => {
  const clock = manualClock(START);
  const store = open(runsDir(), clock);
  store.add([ticket('FAKE-3')]);
  clock.advance(1_000);
  store.add([ticket('FAKE-1'), ticket('FAKE-2')]);
  clock.advance(1_000);
  store.add([ticket('FAKE-4')]);
  store.dispatched('ticket:FAKE-3', 'run');
  store.failed('ticket:FAKE-3', 'tests failed');
  store.dispatched('ticket:FAKE-2', 'run');
  expect(store.due().map((item) => item.dedupKey)).toEqual(['ticket:FAKE-1', 'ticket:FAKE-4']);
  clock.advance(60_000);
  expect(store.due().map((item) => item.dedupKey)).toEqual(['ticket:FAKE-3', 'ticket:FAKE-1', 'ticket:FAKE-4']);
});

test('a failed poll counts a failure, a refused one records the pause, and a poll that succeeds clears both', () => {
  const runs = runsDir();
  const clock = manualClock(START);
  const store = open(runs, clock);
  const failure = { port: 'ticketSource', adapter: 'linear', code: 'unavailable', message: 'down' } as const;
  store.pollFailed({ ...failure, paused: false, retryInMs: 60_000 });
  store.pollFailed({ ...failure, paused: false, retryInMs: 120_000 });
  expect(store.snapshot().polling).toEqual({ label: 'sail', failures: 2 });
  clock.advance(5_000);
  store.pollFailed({ ...failure, code: 'unauthorized', message: 'bad key', paused: true });
  expect(store.snapshot().polling).toEqual({
    label: 'sail',
    failures: 2,
    paused: {
      port: 'ticketSource',
      adapter: 'linear',
      code: 'unauthorized',
      message: 'bad key',
      at: '2026-10-14T09:00:05.000Z',
    },
  });
  store.polled({ kind: 'ticket', found: 1, added: 0, durationMs: 12 });
  expect(store.snapshot().polling).toEqual({ label: 'sail', failures: 0, lastPolledAt: '2026-10-14T09:00:05.000Z' });
  expect(queueEvents(queueDir(runs, 'ticket-to-pr')).map(({ ts, ...event }) => event)).toEqual([
    { seq: 1, type: 'queue:error', workflow: 'ticket-to-pr', ...failure, paused: false, retryInMs: 60_000 },
    { seq: 2, type: 'queue:error', workflow: 'ticket-to-pr', ...failure, paused: false, retryInMs: 120_000 },
    {
      seq: 3,
      type: 'queue:error',
      workflow: 'ticket-to-pr',
      ...failure,
      code: 'unauthorized',
      message: 'bad key',
      paused: true,
    },
    {
      seq: 4,
      type: 'queue:polled',
      workflow: 'ticket-to-pr',
      kind: 'ticket',
      label: 'sail',
      found: 1,
      added: 0,
      durationMs: 12,
    },
  ]);
  expect(queueEventIssues(queueDir(runs, 'ticket-to-pr'))).toEqual([]);
});

test('a store reopened on the same directory reads back the same queue, and continues its events', () => {
  const runs = runsDir();
  const clock = manualClock(START);
  const store = open(runs, clock);
  store.add([ticket('FAKE-1'), ticket('FAKE-2')]);
  store.dispatched('ticket:FAKE-2', 'FAKE-2-01');
  store.failed('ticket:FAKE-2', 'tests failed');
  store.pollFailed({ port: 'ticketSource', adapter: 'fake', message: 'down', paused: false, retryInMs: 60_000 });
  const reopened = open(runs, clock);
  expect(reopened.snapshot()).toEqual(store.snapshot());
  expect(reopened.add([ticket('FAKE-3')])).toBe(1);
  expect(queueEvents(queueDir(runs, 'ticket-to-pr')).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
});

test("two workflows' stores keep their own queue.json and events.ndjson", () => {
  const runs = runsDir();
  const a = open(runs, manualClock(START), 'a');
  const b = open(runs, manualClock(START), 'b');
  a.add([ticket('FAKE-1')]);
  b.add([ticket('FAKE-2'), ticket('FAKE-1')]);
  const written = ['a', 'b'].map((workflow) => existsSync(join(runs, 'queue', workflow, 'queue.json')));
  expect(written).toEqual([true, true]);
  const items = (workflow: string) =>
    JSON.parse(readFileSync(join(runs, 'queue', workflow, 'queue.json'), 'utf8')).items.map(
      (item: { dedupKey: string }) => item.dedupKey,
    );
  expect([items('a'), items('b')]).toEqual([['ticket:FAKE-1'], ['ticket:FAKE-2', 'ticket:FAKE-1']]);
  expect(queueEvents(join(runs, 'queue', 'a')).map((event) => event.dedupKey)).toEqual(['ticket:FAKE-1']);
  expect(queueEvents(join(runs, 'queue', 'b')).map((event) => event.dedupKey)).toEqual([
    'ticket:FAKE-2',
    'ticket:FAKE-1',
  ]);
});

test('a queue.json that is not JSON refuses on open, naming the file', () => {
  const runs = runsDir();
  const dir = queueDir(runs, 'ticket-to-pr');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'queue.json'), '{');
  expect(openQueue({ runsDir: runs, workflow: 'ticket-to-pr', label: 'sail', now: manualClock(START) })).toEqual({
    refused: expect.stringMatching(new RegExp(`^${join(dir, 'queue.json').replaceAll('.', '\\.')} can't be read: .`)),
  });
});

test('queue.json survives a writer killed mid-write: it opens, holds a prefix of what was added, and takes the next write', async () => {
  const runs = runsDir();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'helpers', 'queue-writer.ts'), runs], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let printed = '';
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    printed += decoder.decode(chunk);
    if (printed.split('\n').length > 10) break;
  }
  child.kill('SIGKILL');
  await child.exited;
  expect(printed.split('\n').length).toBeGreaterThan(10);

  const dir = queueDir(runs, 'writer');
  expect(existsSync(join(dir, 'queue.json'))).toBe(true);
  writeFileSync(join(dir, 'queue.json.tmp'), '{"half":');
  const store = openQueue({ runsDir: runs, workflow: 'writer', label: 'sail', now: manualClock(START) });
  if ('refused' in store) throw new Error(store.refused);
  const added = store.snapshot().items.map((item) => item.dedupKey);
  expect(added.length).toBeGreaterThanOrEqual(10);
  expect(added).toEqual(Array.from({ length: added.length }, (_, index) => `ticket:FAKE-${index + 1}`));
  expect(store.add([ticket('FAKE-0')])).toBe(1);
  expect(JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')).items).toHaveLength(added.length + 1);
  expect(existsSync(join(dir, 'queue.json.tmp'))).toBe(false);
}, 30_000);

test('a change whose queue.json write throws leaves the store, the file and the events as they were (review #1.10)', () => {
  const runs = runsDir();
  const store = open(runs);
  store.add([ticket('FAKE-1')]);
  const dir = queueDir(runs, 'ticket-to-pr');
  const before = { queue: store.snapshot(), file: readFileSync(join(dir, 'queue.json'), 'utf8') };
  chmodSync(dir, 0o555);
  try {
    expect(() => store.add([ticket('FAKE-2')])).toThrow('EACCES');
    expect(() => store.dispatched('ticket:FAKE-1', 'FAKE-1-01')).toThrow('EACCES');
  } finally {
    chmodSync(dir, 0o755);
  }
  expect(store.snapshot()).toEqual(before.queue);
  expect(readFileSync(join(dir, 'queue.json'), 'utf8')).toBe(before.file);
  expect(store.due().map((item) => item.dedupKey)).toEqual(['ticket:FAKE-1']);
  expect(typesIn(runs)).toEqual(['queue:item_added']);
  expect(store.add([ticket('FAKE-2')])).toBe(1);
  expect(keys(store)).toEqual(['ticket:FAKE-1 queued', 'ticket:FAKE-2 queued']);
});

test('a write that throws after its rename leaves the store holding what queue.json holds, so the next change keeps it (review #2.1)', () => {
  const runs = runsDir();
  const store = open(runs);
  store.add([ticket('FAKE-1')]);
  const dir = queueDir(runs, 'ticket-to-pr');
  // Writable and searchable but not readable: the temp file is written and renamed, and the directory's sync fails.
  chmodSync(dir, 0o333);
  try {
    expect(() => store.dispatched('ticket:FAKE-1', 'FAKE-1-01')).toThrow('EACCES');
  } finally {
    chmodSync(dir, 0o755);
  }
  const onDisk = () => JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8'));
  expect(onDisk().items[0]).toMatchObject({ state: 'dispatched', attempts: 1, runId: 'FAKE-1-01' });
  expect(store.snapshot()).toEqual(onDisk());
  store.polled({ kind: 'ticket', found: 0, added: 0, durationMs: 0 });
  expect(onDisk().items[0]).toMatchObject({ state: 'dispatched', attempts: 1, runId: 'FAKE-1-01' });
});

test("a write that fails after its rename, when queue.json then can't be read back, blocks changes until it can (review #3.1)", () => {
  const runs = runsDir();
  const store = open(runs);
  store.add([ticket('FAKE-1')]);
  const dir = queueDir(runs, 'ticket-to-pr');
  const path = join(dir, 'queue.json');
  // The new queue.json is created unreadable, and the directory's sync after the rename fails.
  const umask = process.umask(0o777);
  chmodSync(dir, 0o333);
  try {
    expect(() => store.dispatched('ticket:FAKE-1', 'FAKE-1-01')).toThrow('EACCES');
  } finally {
    process.umask(umask);
    chmodSync(dir, 0o755);
  }
  expect(() => store.polled({ kind: 'ticket', found: 0, added: 0, durationMs: 0 })).toThrow(
    `${path} can't be read: EACCES`,
  );
  chmodSync(path, 0o644);
  const onDisk = () => JSON.parse(readFileSync(path, 'utf8'));
  expect(onDisk().items[0]).toMatchObject({ state: 'dispatched', attempts: 1, runId: 'FAKE-1-01' });
  store.polled({ kind: 'ticket', found: 0, added: 0, durationMs: 0 });
  expect(onDisk().items[0]).toMatchObject({ state: 'dispatched', attempts: 1, runId: 'FAKE-1-01' });
  expect(store.snapshot()).toEqual(onDisk());
});
