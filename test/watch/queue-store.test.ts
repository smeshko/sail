// The queue store: one writer of queue.json per watched workflow, deduplicating by key, counting attempts and parking.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequest } from '../../src/ports/types';
import {
  dedupKey,
  openQueue,
  type QueueItem,
  type QueuePolicy,
  type QueueStore,
  queueDir,
} from '../../src/watch/queue-store';
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
const POLICY: QueuePolicy = {
  maxAttempts: 2,
  retryDelaysMs: [60_000],
  pollBackoffMs: [60_000],
  doneKept: 2,
  usageLimitBackoffMs: 15 * 60_000,
};

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

test("when the events of an add can't be appended, every added item's event is written once the file recovers (review #3.4)", () => {
  const runs = runsDir();
  const store = open(runs);
  const events = join(queueDir(runs, 'ticket-to-pr'), 'events.ndjson');
  store.polled({ kind: 'ticket', found: 0, added: 0, durationMs: 0 });
  chmodSync(events, 0o444);
  try {
    expect(() => store.add([ticket('FAKE-1'), ticket('FAKE-2'), ticket('FAKE-3')])).toThrow('EACCES');
  } finally {
    chmodSync(events, 0o644);
  }
  expect(keys(store)).toEqual(['ticket:FAKE-1 queued', 'ticket:FAKE-2 queued', 'ticket:FAKE-3 queued']);
  store.polled({ kind: 'ticket', found: 3, added: 3, durationMs: 0 });
  expect(queueEvents(queueDir(runs, 'ticket-to-pr')).map((event) => [event.seq, event.dedupKey ?? event.type])).toEqual(
    [
      [1, 'queue:polled'],
      [2, 'ticket:FAKE-1'],
      [3, 'ticket:FAKE-2'],
      [4, 'ticket:FAKE-3'],
      [5, 'queue:polled'],
    ],
  );
  expect(queueEventIssues(queueDir(runs, 'ticket-to-pr'))).toEqual([]);
});

// What dispatch and the watch set add (DECISIONS D7, D8, D12).
const RUN = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const RUN_2 = 'FAKE-1-01M3BWP0000000000000000000';
const queueText = (runs: string) => readFileSync(join(queueDir(runs, 'ticket-to-pr'), 'queue.json'), 'utf8');
const lastEvent = (runs: string) => {
  const { seq, ts, ...event } = queueEvents(queueDir(runs, 'ticket-to-pr')).at(-1) ?? {};
  return event;
};

test('spawned records the pid of a dispatched item and emits queue:dispatched naming its run, attempt and pid, and a queued item throws', () => {
  const runs = runsDir();
  const store = open(runs);
  store.add([ticket('FAKE-1'), ticket('FAKE-2')]);
  store.dispatched('ticket:FAKE-1', RUN);
  store.spawned('ticket:FAKE-1', 4242);
  expect(store.snapshot().items[0]).toMatchObject({ state: 'dispatched', runId: RUN, attempts: 1, pid: 4242 });
  expect(open(runs).snapshot().items[0]?.pid).toBe(4242);
  expect(lastEvent(runs)).toEqual({
    type: 'queue:dispatched',
    workflow: 'ticket-to-pr',
    dedupKey: 'ticket:FAKE-1',
    run: RUN,
    attempt: 1,
    pid: 4242,
  });
  expect(() => store.spawned('ticket:FAKE-2', 4243)).toThrow(
    "ticket-to-pr's item ticket:FAKE-2 is queued, not dispatched",
  );
  store.failed('ticket:FAKE-1', 'run failed');
  store.dispatched('ticket:FAKE-1', RUN_2);
  const again = store.snapshot().items[0];
  expect([again?.runId, again?.attempts, again?.pid]).toEqual([RUN_2, 2, undefined]);
  expect(typesIn(runs).filter((type) => type === 'queue:dispatched')).toHaveLength(1);
  expect(queueEventIssues(queueDir(runs, 'ticket-to-pr'))).toEqual([]);
});

test('drop takes the item out with queue:dropped and its reason, a later add queues the ticket again with no attempts, and an unknown key throws', () => {
  const runs = runsDir();
  const store = open(runs);
  store.add([ticket('FAKE-1'), ticket('FAKE-2')]);
  store.dispatched('ticket:FAKE-1', RUN);
  store.drop('ticket:FAKE-1', 'it is In Progress');
  expect(keys(store)).toEqual(['ticket:FAKE-2 queued']);
  expect(lastEvent(runs)).toEqual({
    type: 'queue:dropped',
    workflow: 'ticket-to-pr',
    dedupKey: 'ticket:FAKE-1',
    reason: 'it is In Progress',
  });
  expect(store.add([ticket('FAKE-1')])).toBe(1);
  expect(store.snapshot().items.find((item) => item.dedupKey === 'ticket:FAKE-1')).toMatchObject({
    state: 'queued',
    attempts: 0,
  });
  expect(() => store.drop('ticket:FAKE-9', 'gone')).toThrow("ticket-to-pr's queue has no item ticket:FAKE-9");
  expect(queueEventIssues(queueDir(runs, 'ticket-to-pr'))).toEqual([]);
});

test('skippedLeased, watched and unwatched emit their events and leave queue.json byte-identical', () => {
  const runs = runsDir();
  const clock = manualClock(START);
  const store = open(runs, clock);
  store.add([ticket('FAKE-3')]);
  const before = queueText(runs);
  // A write would stamp a later updatedAt.
  clock.advance(1000);
  store.skippedLeased('ticket:FAKE-3', 'sail/FAKE-3-ticket-fake-3', RUN);
  store.watched({ pid: 4242, everyMs: 30_000, maxConcurrentRuns: 2 });
  store.unwatched(4242);
  expect(queueText(runs)).toBe(before);
  expect(
    queueEvents(queueDir(runs, 'ticket-to-pr'))
      .slice(1)
      .map(({ seq, ts, ...event }) => event),
  ).toEqual([
    {
      type: 'queue:skipped_leased',
      workflow: 'ticket-to-pr',
      dedupKey: 'ticket:FAKE-3',
      branch: 'sail/FAKE-3-ticket-fake-3',
      heldBy: RUN,
    },
    { type: 'watch:added', workflow: 'ticket-to-pr', pid: 4242, label: 'sail', everyMs: 30_000, maxConcurrentRuns: 2 },
    { type: 'watch:removed', workflow: 'ticket-to-pr', pid: 4242 },
  ]);
  expect(queueEventIssues(queueDir(runs, 'ticket-to-pr'))).toEqual([]);
});

/** One of every change the store makes, on `store`. */
function everyChange(store: QueueStore): void {
  store.watched({ pid: 4242, everyMs: 30_000, maxConcurrentRuns: 1 });
  store.add([ticket('FAKE-1'), ticket('FAKE-2'), ticket('FAKE-3')]);
  store.polled({ kind: 'ticket', found: 3, added: 3, durationMs: 5 });
  store.skippedLeased('ticket:FAKE-3', 'sail/FAKE-3-ticket-fake-3', RUN);
  store.dispatched('ticket:FAKE-1', RUN);
  store.spawned('ticket:FAKE-1', 4243);
  store.failed('ticket:FAKE-1', 'run failed');
  store.dispatched('ticket:FAKE-1', RUN_2);
  store.failed('ticket:FAKE-1', 'run failed again');
  store.drop('ticket:FAKE-2', 'it is In Progress');
  store.pollFailed({ port: 'ticketSource', adapter: 'fake', message: 'down', paused: false, retryInMs: 60_000 });
  store.unwatched(4242);
}

test('onEvent hears every event the store emits, in seq order, and one that throws leaves queue.json and the events as they would be', () => {
  const heard = runsDir();
  const events: { seq: number; type: string }[] = [];
  const store = openQueue({
    runsDir: heard,
    workflow: 'ticket-to-pr',
    label: 'sail',
    now: manualClock(START),
    policy: POLICY,
    onEvent: (event) => events.push(event),
  });
  if ('refused' in store) throw new Error(store.refused);
  everyChange(store);
  expect(events).toEqual(queueEvents(queueDir(heard, 'ticket-to-pr')) as typeof events);
  expect(events.map((event) => event.type)).toEqual([
    'watch:added',
    'queue:item_added',
    'queue:item_added',
    'queue:item_added',
    'queue:polled',
    'queue:skipped_leased',
    'queue:dispatched',
    'queue:parked',
    'queue:dropped',
    'queue:error',
    'watch:removed',
  ]);

  const quiet = runsDir();
  const throwing = openQueue({
    runsDir: quiet,
    workflow: 'ticket-to-pr',
    label: 'sail',
    now: manualClock(START),
    policy: POLICY,
    onEvent: () => {
      throw new Error('the terminal is gone');
    },
  });
  if ('refused' in throwing) throw new Error(throwing.refused);
  everyChange(throwing);
  expect(queueText(quiet)).toBe(queueText(heard));
  expect(readFileSync(join(queueDir(quiet, 'ticket-to-pr'), 'events.ndjson'), 'utf8')).toBe(
    readFileSync(join(queueDir(heard, 'ticket-to-pr'), 'events.ndjson'), 'utf8'),
  );
  expect(queueEventIssues(queueDir(heard, 'ticket-to-pr'))).toEqual([]);
});

// What 13.3 adds (DECISIONS D3, D6, D8, D9): adoption and resume, parking at once, a requeue by hand, and forced items.

/** Every event of the queue after the first `skip`, without its envelope. */
const eventsAfter = (runs: string, skip: number) =>
  queueEvents(queueDir(runs, 'ticket-to-pr'))
    .slice(skip)
    .map(({ seq, ts, ...event }) => event);

test('adopted and resumed record the pid a dispatched run is alive as, with run:adopted and run:resumed naming the run and where it was, and an item not dispatched throws', () => {
  const runs = runsDir();
  const store = open(runs);
  store.add([ticket('FAKE-1'), ticket('FAKE-2')]);
  store.dispatched('ticket:FAKE-1', RUN);
  store.spawned('ticket:FAKE-1', 4243);
  const before = queueEvents(queueDir(runs, 'ticket-to-pr')).length;
  store.adopted('ticket:FAKE-1', 4300);
  const adopted = open(runs).snapshot().items[0]?.pid;
  store.resumed('ticket:FAKE-1', 4301, { status: 'suspended', stopReason: 'interrupted' });
  const notDispatched = "ticket-to-pr's item ticket:FAKE-2 is queued, not dispatched";
  expect(() => store.adopted('ticket:FAKE-2', 4302)).toThrow(notDispatched);
  expect(() => store.resumed('ticket:FAKE-2', 4302, { status: 'running' })).toThrow(notDispatched);
  const [first, second] = open(runs).snapshot().items;
  expect({
    adopted,
    first: [first?.state, first?.attempts, first?.runId, first?.pid],
    second: [second?.state, second?.pid],
    events: eventsAfter(runs, before),
    issues: queueEventIssues(queueDir(runs, 'ticket-to-pr')),
  }).toEqual({
    adopted: 4300,
    first: ['dispatched', 1, RUN, 4301],
    second: ['queued', undefined],
    events: [
      { type: 'run:adopted', workflow: 'ticket-to-pr', dedupKey: 'ticket:FAKE-1', run: RUN, pid: 4300 },
      {
        type: 'run:resumed',
        workflow: 'ticket-to-pr',
        dedupKey: 'ticket:FAKE-1',
        run: RUN,
        pid: 4301,
        from: { status: 'suspended', stopReason: 'interrupted' },
      },
    ],
    issues: [],
  });
});

test('parked parks an item on its first attempt, with queue:parked and the reason, and it is never due again', () => {
  const runs = runsDir();
  const store = open(runs);
  store.add([ticket('FAKE-1')]);
  store.dispatched('ticket:FAKE-1', RUN);
  store.spawned('ticket:FAKE-1', 4243);
  store.parked('ticket:FAKE-1', `run ${RUN} was stopped`);
  expect({
    item: open(runs).snapshot().items[0],
    event: lastEvent(runs),
    due: store.due(),
    issues: queueEventIssues(queueDir(runs, 'ticket-to-pr')),
  }).toEqual({
    item: {
      dedupKey: 'ticket:FAKE-1',
      source: { kind: 'ticket', ticketKey: 'FAKE-1' },
      title: 'Ticket FAKE-1',
      url: 'fake://tickets/FAKE-1',
      state: 'parked',
      attempts: 1,
      addedAt: START,
      runId: RUN,
      pid: 4243,
      reason: `run ${RUN} was stopped`,
      finishedAt: START,
    },
    event: {
      type: 'queue:parked',
      workflow: 'ticket-to-pr',
      dedupKey: 'ticket:FAKE-1',
      attempts: 1,
      reason: `run ${RUN} was stopped`,
    },
    due: [],
    issues: [],
  });
});

test('hold() persists held and emits queue:held once, extends only to a later time, release() clears it and emits queue:released, a reopened store keeps held, and no item changes', () => {
  const runs = runsDir();
  const clock = manualClock(START);
  const store = open(runs, clock);
  store.add([ticket('FAKE-1')]);
  const items = store.snapshot().items;
  const until = '2026-10-14T13:20:00.000Z';
  store.hold(until, 'run-1', 'spec#1 hit the usage limit');
  store.hold('2026-10-14T10:00:00.000Z', 'run-2', 'earlier');
  store.hold(until, 'run-3', 'same time');
  const held = store.snapshot().held;
  const reopened = open(runs, clock);
  store.hold('2026-10-14T14:00:00.000Z', 'run-4', 'later');
  expect({
    held,
    reopened: reopened.snapshot().held,
    extended: store.snapshot().held,
    items: store.snapshot().items,
    types: typesIn(runs).filter((type) => String(type).startsWith('queue:h')),
  }).toEqual({
    held: { until, runId: 'run-1', reason: 'spec#1 hit the usage limit', at: START },
    reopened: { until, runId: 'run-1', reason: 'spec#1 hit the usage limit', at: START },
    extended: { until: '2026-10-14T14:00:00.000Z', runId: 'run-4', reason: 'later', at: START },
    items,
    types: ['queue:held', 'queue:held'],
  });
  store.release();
  store.release();
  expect({ held: store.snapshot().held, types: typesIn(runs).filter((type) => type === 'queue:released') }).toEqual({
    held: undefined,
    types: ['queue:released'],
  });
  expect(queueEventIssues(queueDir(runs, 'ticket-to-pr'))).toEqual([]);
});

test('requeue puts a parked or a failed item back queued with no attempts and nothing of its last run, with queue:requeued, and a queued, dispatched or done item throws naming its state and changes nothing', () => {
  const runs = runsDir();
  const store = open(runs);
  store.add(['FAKE-1', 'FAKE-2', 'FAKE-3', 'FAKE-4', 'FAKE-5'].map((key) => ticket(key)));
  for (const attempt of [RUN, RUN_2]) {
    store.dispatched('ticket:FAKE-1', attempt);
    store.spawned('ticket:FAKE-1', 4243);
    store.failed('ticket:FAKE-1', 'spec blocked');
  }
  store.dispatched('ticket:FAKE-2', 'FAKE-2-01M3BWNZM08Q4T6V2XRJ5KWD3N');
  store.failed('ticket:FAKE-2', 'run failed');
  store.dispatched('ticket:FAKE-4', 'FAKE-4-01M3BWNZM08Q4T6V2XRJ5KWD3N');
  store.dispatched('ticket:FAKE-5', 'FAKE-5-01M3BWNZM08Q4T6V2XRJ5KWD3N');
  store.done('ticket:FAKE-5');
  const before = queueEvents(queueDir(runs, 'ticket-to-pr')).length;
  const states = keys(store);
  store.requeue('ticket:FAKE-1', 'requeued by hand');
  store.requeue('ticket:FAKE-2', 'requeued by hand');
  const requeued = queueText(runs);
  const refusals = ['FAKE-3', 'FAKE-4', 'FAKE-5'].map((key) => {
    try {
      store.requeue(`ticket:${key}`, 'requeued by hand');
      return 'requeued';
    } catch (error) {
      return (error as Error).message;
    }
  });
  const fresh = (key: string): QueueItem => ({
    dedupKey: `ticket:${key}`,
    source: { kind: 'ticket', ticketKey: key },
    title: `Ticket ${key}`,
    url: `fake://tickets/${key}`,
    state: 'queued',
    attempts: 0,
    addedAt: START,
  });
  expect({
    states,
    items: open(runs).snapshot().items.slice(0, 2),
    refusals,
    unchanged: queueText(runs) === requeued,
    events: eventsAfter(runs, before),
    issues: queueEventIssues(queueDir(runs, 'ticket-to-pr')),
  }).toEqual({
    states: [
      'ticket:FAKE-1 parked',
      'ticket:FAKE-2 failed',
      'ticket:FAKE-3 queued',
      'ticket:FAKE-4 dispatched',
      'ticket:FAKE-5 done',
    ],
    items: [fresh('FAKE-1'), fresh('FAKE-2')],
    refusals: [
      "ticket-to-pr's item ticket:FAKE-3 is queued: only a parked or failed item is requeued",
      "ticket-to-pr's item ticket:FAKE-4 is dispatched: only a parked or failed item is requeued",
      "ticket-to-pr's item ticket:FAKE-5 is done: only a parked or failed item is requeued",
    ],
    unchanged: true,
    events: [
      { type: 'queue:requeued', workflow: 'ticket-to-pr', dedupKey: 'ticket:FAKE-1', reason: 'requeued by hand' },
      { type: 'queue:requeued', workflow: 'ticket-to-pr', dedupKey: 'ticket:FAKE-2', reason: 'requeued by hand' },
    ],
    issues: [],
  });
});

test('a forced add marks its items forced, and a queue.json written before the field existed still reads', () => {
  const runs = runsDir();
  const store = open(runs);
  store.add([ticket('FAKE-1')], { forced: true });
  store.add([ticket('FAKE-2')]);
  const forced = open(runs)
    .snapshot()
    .items.map((item) => [item.dedupKey, item.forced]);
  const path = join(queueDir(runs, 'ticket-to-pr'), 'queue.json');
  const older = JSON.parse(readFileSync(path, 'utf8'));
  for (const item of older.items) delete item.forced;
  writeFileSync(path, JSON.stringify(older));
  expect([
    forced,
    open(runs)
      .snapshot()
      .items.map((item) => item.dedupKey),
  ]).toEqual([
    [
      ['ticket:FAKE-1', true],
      ['ticket:FAKE-2', undefined],
    ],
    ['ticket:FAKE-1', 'ticket:FAKE-2'],
  ]);
});

/** A pull request as a CodeHost lists it: open, ready and labelled, from `sail/FAKE-<n>-x`, at `headSha`. */
const pullRequest = (number: number, headSha: string): PullRequest => ({
  number,
  url: `fake://codehost/stub/pull/${number}`,
  title: `Pull request ${number}`,
  base: 'main',
  head: `sail/FAKE-${number}-x`,
  headSha,
  draft: false,
  state: 'open',
  labels: ['sail'],
  raw: null,
});

test('addPullRequests queues a pull request once per head sha, as pr:<number>@<sha7> with its branch, and a done pr: key stays taken while a done ticket: key is queued again', () => {
  const runs = runsDir();
  const store = open(runs);
  const [first, moved] = ['c'.repeat(40), 'd'.repeat(40)];
  const added = [store.addPullRequests([pullRequest(12, first), pullRequest(12, first)])];
  expect(keys(store)).toEqual(['pr:12@ccccccc queued']);
  store.done('pr:12@ccccccc');
  added.push(store.addPullRequests([pullRequest(12, first)]), store.addPullRequests([pullRequest(12, moved)]));
  store.add([ticket('FAKE-1')]);
  store.done('ticket:FAKE-1');
  added.push(store.add([ticket('FAKE-1')]));
  const [item] = store.snapshot().items;
  expect({
    added,
    keys: keys(store),
    item: item === undefined ? undefined : [item.source, item.title, item.url],
    key: dedupKey({ kind: 'pr', number: 12, headSha: first, branch: 'sail/FAKE-12-x' }),
    issues: queueEventIssues(queueDir(runs, 'ticket-to-pr')),
  }).toEqual({
    added: [1, 0, 1, 1],
    keys: ['pr:12@ccccccc done', 'pr:12@ddddddd queued', 'ticket:FAKE-1 queued'],
    item: [
      { kind: 'pr', number: 12, headSha: first, branch: 'sail/FAKE-12-x' },
      'Pull request 12',
      'fake://codehost/stub/pull/12',
    ],
    key: 'pr:12@ccccccc',
    issues: [],
  });
});

test('a new head sha that shares its first 7 with a done item is queued in its place, and one that shares them with an item not done waits for it (review R1-1)', () => {
  const store = open(runsDir());
  const [old, collides, again] = [`1234567${'a'.repeat(33)}`, `1234567${'b'.repeat(33)}`, `1234567${'c'.repeat(33)}`];
  const added = [store.addPullRequests([pullRequest(12, old)])];
  store.done('pr:12@1234567');
  added.push(store.addPullRequests([pullRequest(12, collides)]), store.addPullRequests([pullRequest(12, collides)]));
  const queued = store.snapshot().items.map((item) => [item.dedupKey, item.state, item.source]);
  added.push(store.addPullRequests([pullRequest(12, again)]));
  expect({ added, queued, after: store.snapshot().items.map((item) => [item.state, item.source]) }).toEqual({
    added: [1, 1, 0, 0],
    queued: [['pr:12@1234567', 'queued', { kind: 'pr', number: 12, headSha: collides, branch: 'sail/FAKE-12-x' }]],
    after: [['queued', { kind: 'pr', number: 12, headSha: collides, branch: 'sail/FAKE-12-x' }]],
  });
});

/** The dedup keys `due()` gives, and the order `queue.json` holds them in. */
const dueOrder = (store: QueueStore) => store.due().map((item) => item.dedupKey.replace('ticket:', ''));
const fileOrder = (store: QueueStore) => store.snapshot().items.map((item) => item.dedupKey.replace('ticket:', ''));

test('tickets added together and across polls come out urgent, high, medium, low, then none, oldest first within a priority', () => {
  const clock = manualClock(START);
  const store = open(runsDir(), clock);
  store.add([
    ticket('FAKE-1'),
    ticket('FAKE-2', { priority: 'low' }),
    ticket('FAKE-3', { priority: 'medium' }),
    ticket('FAKE-4', { priority: 'none' }),
  ]);
  clock.advance(1_000);
  store.add([ticket('FAKE-5', { priority: 'urgent' }), ticket('FAKE-6', { priority: 'low' }), ticket('FAKE-7')]);
  clock.advance(1_000);
  store.add([ticket('FAKE-8', { priority: 'high' }), ticket('FAKE-9', { priority: 'urgent' })]);
  const expected = ['FAKE-5', 'FAKE-9', 'FAKE-8', 'FAKE-3', 'FAKE-2', 'FAKE-6', 'FAKE-1', 'FAKE-4', 'FAKE-7'];
  expect({ due: dueOrder(store), file: fileOrder(store) }).toEqual({ due: expected, file: expected });
  expect(store.snapshot().items.map((item) => item.priority)).toEqual([
    'urgent',
    'urgent',
    'high',
    'medium',
    'low',
    'low',
    undefined,
    'none',
    undefined,
  ]);
});

test('a re-add that finds a queued ticket at another priority updates the item and moves it, and is not counted as added', () => {
  const clock = manualClock(START);
  const runs = runsDir();
  const store = open(runs, clock);
  store.add([ticket('FAKE-1'), ticket('FAKE-2'), ticket('FAKE-3', { priority: 'low' })]);
  clock.advance(1_000);
  const added = store.add([
    ticket('FAKE-1'),
    ticket('FAKE-2', { priority: 'urgent' }),
    ticket('FAKE-3', { priority: 'low' }),
  ]);
  expect({ added, due: dueOrder(store), events: typesIn(runs) }).toEqual({
    added: 0,
    due: ['FAKE-2', 'FAKE-3', 'FAKE-1'],
    events: ['queue:item_added', 'queue:item_added', 'queue:item_added'],
  });
  expect(store.snapshot().items[0]?.priority).toBe('urgent');
  store.add([ticket('FAKE-2')]);
  expect({
    due: dueOrder(store),
    priority: store.snapshot().items.find((item) => item.dedupKey === 'ticket:FAKE-2')?.priority,
  }).toEqual({
    due: ['FAKE-3', 'FAKE-1', 'FAKE-2'],
    priority: undefined,
  });
});

test('pull requests rank like unprioritised tickets and stay oldest first, behind prioritised tickets', () => {
  const clock = manualClock(START);
  const store = open(runsDir(), clock);
  store.addPullRequests([pullRequest(12, 'c'.repeat(40))]);
  clock.advance(1_000);
  store.addPullRequests([pullRequest(13, 'd'.repeat(40))]);
  clock.advance(1_000);
  store.add([ticket('FAKE-1', { priority: 'low' })]);
  expect(store.due().map((item) => item.dedupKey)).toEqual(['ticket:FAKE-1', 'pr:12@ccccccc', 'pr:13@ddddddd']);
});

test('a failed item that retries and a requeued item are placed by their priority again', () => {
  const retried = open(runsDir(), manualClock(START));
  retried.add([ticket('FAKE-1', { priority: 'low' })]);
  retried.dispatched('ticket:FAKE-1', 'run');
  retried.add([ticket('FAKE-2', { priority: 'urgent' })]);
  expect(fileOrder(retried)).toEqual(['FAKE-1', 'FAKE-2']);
  retried.failed('ticket:FAKE-1', 'tests failed');
  expect(fileOrder(retried)).toEqual(['FAKE-2', 'FAKE-1']);

  const requeued = open(runsDir(), manualClock(START));
  requeued.add([ticket('FAKE-3', { priority: 'low' })]);
  requeued.dispatched('ticket:FAKE-3', 'run');
  requeued.parked('ticket:FAKE-3', 'by hand');
  requeued.add([ticket('FAKE-4', { priority: 'medium' })]);
  expect(fileOrder(requeued)).toEqual(['FAKE-3', 'FAKE-4']);
  requeued.requeue('ticket:FAKE-3', 'requeued by hand');
  expect(fileOrder(requeued)).toEqual(['FAKE-4', 'FAKE-3']);
});

test('a queue.json written before priorities existed reads and dispatches in the order it holds', () => {
  const runs = runsDir();
  const dir = queueDir(runs, 'ticket-to-pr');
  mkdirSync(dir, { recursive: true });
  // No priority on any item, and the file's order is not the order of addedAt: FAKE-2 was added after FAKE-1.
  const item = (key: string, addedAt: string) => ({
    dedupKey: `ticket:${key}`,
    source: { kind: 'ticket', ticketKey: key },
    title: `Ticket ${key}`,
    url: `fake://tickets/${key}`,
    state: 'queued',
    attempts: 0,
    addedAt,
  });
  writeFileSync(
    join(dir, 'queue.json'),
    `${JSON.stringify({
      version: 1,
      workflow: 'ticket-to-pr',
      updatedAt: START,
      polling: { label: 'sail', failures: 0 },
      items: [item('FAKE-2', '2026-09-24T10:56:00.000Z'), item('FAKE-1', '2026-09-24T10:55:00.000Z')],
    })}\n`,
  );
  const reopened = open(runs);
  expect({
    items: reopened.snapshot().items.map((item) => [item.dedupKey, item.priority, item.moved]),
    due: dueOrder(reopened),
  }).toEqual({
    items: [
      ['ticket:FAKE-2', undefined, undefined],
      ['ticket:FAKE-1', undefined, undefined],
    ],
    due: ['FAKE-2', 'FAKE-1'],
  });
});

test('move puts a queued item before or after another, marks it moved, and emits queue:moved with the place and the reason', () => {
  const runs = runsDir();
  const store = open(runs);
  store.add([ticket('FAKE-1'), ticket('FAKE-2'), ticket('FAKE-3'), ticket('FAKE-4')]);
  store.move('ticket:FAKE-4', { before: 'ticket:FAKE-1' }, 'moved by hand');
  expect(fileOrder(store)).toEqual(['FAKE-4', 'FAKE-1', 'FAKE-2', 'FAKE-3']);
  store.move('ticket:FAKE-1', { after: 'ticket:FAKE-3' }, 'moved by hand');
  expect(fileOrder(store)).toEqual(['FAKE-4', 'FAKE-2', 'FAKE-3', 'FAKE-1']);
  expect(dueOrder(store)).toEqual(['FAKE-4', 'FAKE-2', 'FAKE-3', 'FAKE-1']);
  expect(store.snapshot().items.map((item) => item.moved)).toEqual([true, undefined, undefined, true]);
  expect(
    queueEvents(queueDir(runs, 'ticket-to-pr'))
      .filter((event) => event.type === 'queue:moved')
      .map(({ seq, ts, ...event }) => event),
  ).toEqual([
    {
      type: 'queue:moved',
      workflow: 'ticket-to-pr',
      dedupKey: 'ticket:FAKE-4',
      before: 'ticket:FAKE-1',
      reason: 'moved by hand',
    },
    {
      type: 'queue:moved',
      workflow: 'ticket-to-pr',
      dedupKey: 'ticket:FAKE-1',
      after: 'ticket:FAKE-3',
      reason: 'moved by hand',
    },
  ]);
  expect(queueEventIssues(queueDir(runs, 'ticket-to-pr'))).toEqual([]);
});

test('a moved item keeps its place when a later add raises another ticket or changes its own priority', () => {
  const clock = manualClock(START);
  const store = open(runsDir(), clock);
  store.add([ticket('FAKE-5'), ticket('FAKE-7')]);
  store.move('ticket:FAKE-7', { before: 'ticket:FAKE-5' }, 'moved by hand');
  clock.advance(1_000);
  store.add([ticket('FAKE-9', { priority: 'urgent' })]);
  expect(dueOrder(store)).toEqual(['FAKE-7', 'FAKE-9', 'FAKE-5']);
  store.add([ticket('FAKE-7', { priority: 'low' })]);
  expect(dueOrder(store)).toEqual(['FAKE-7', 'FAKE-9', 'FAKE-5']);
  expect(store.snapshot().items[0]).toMatchObject({ dedupKey: 'ticket:FAKE-7', priority: 'low', moved: true });
});

test('dispatching a moved item clears moved, and a retry after a failure is placed by priority again', () => {
  const store = open(runsDir(), manualClock(START));
  store.add([ticket('FAKE-1', { priority: 'high' }), ticket('FAKE-2'), ticket('FAKE-3')]);
  store.move('ticket:FAKE-3', { before: 'ticket:FAKE-1' }, 'moved by hand');
  expect(fileOrder(store)).toEqual(['FAKE-3', 'FAKE-1', 'FAKE-2']);
  store.dispatched('ticket:FAKE-3', 'run');
  expect(store.snapshot().items[0]?.moved).toBeUndefined();
  store.failed('ticket:FAKE-3', 'tests failed');
  expect(fileOrder(store)).toEqual(['FAKE-1', 'FAKE-2', 'FAKE-3']);
});

test('move throws naming the state when the item or the target is not queued, when they are the same, or when one is missing, and changes nothing', () => {
  const runs = runsDir();
  const store = open(runs);
  store.add([ticket('FAKE-1'), ticket('FAKE-2'), ticket('FAKE-3')]);
  store.dispatched('ticket:FAKE-1', 'run');
  const before = JSON.stringify(store.snapshot().items);
  const attempts = [
    () => store.move('ticket:FAKE-1', { before: 'ticket:FAKE-2' }, 'moved by hand'),
    () => store.move('ticket:FAKE-2', { after: 'ticket:FAKE-1' }, 'moved by hand'),
    () => store.move('ticket:FAKE-2', { after: 'ticket:FAKE-2' }, 'moved by hand'),
    () => store.move('ticket:FAKE-9', { after: 'ticket:FAKE-2' }, 'moved by hand'),
    () => store.move('ticket:FAKE-2', { after: 'ticket:FAKE-9' }, 'moved by hand'),
  ];
  expect(
    attempts.map((attempt) => {
      try {
        attempt();
        return 'moved';
      } catch (error) {
        return (error as Error).message;
      }
    }),
  ).toEqual([
    "ticket-to-pr's item ticket:FAKE-1 is dispatched: only a queued item is moved",
    "ticket-to-pr's item ticket:FAKE-1 is dispatched: only a queued item is moved",
    "ticket-to-pr's item ticket:FAKE-2 can't be moved next to itself",
    "ticket-to-pr's queue has no item ticket:FAKE-9",
    "ticket-to-pr's queue has no item ticket:FAKE-9",
  ]);
  expect(JSON.stringify(store.snapshot().items)).toBe(before);
  expect(typesIn(runs).filter((type) => type === 'queue:moved')).toEqual([]);
});

test('a move that leaves the item where it is changes nothing but still emits queue:moved, so a repeated move is safe', () => {
  const runs = runsDir();
  const store = open(runs);
  store.add([ticket('FAKE-1'), ticket('FAKE-2'), ticket('FAKE-3')]);
  store.move('ticket:FAKE-3', { after: 'ticket:FAKE-1' }, 'moved by hand');
  store.move('ticket:FAKE-3', { after: 'ticket:FAKE-1' }, 'moved by hand');
  expect(fileOrder(store)).toEqual(['FAKE-1', 'FAKE-3', 'FAKE-2']);
  expect(typesIn(runs).filter((type) => type === 'queue:moved')).toHaveLength(2);
});
