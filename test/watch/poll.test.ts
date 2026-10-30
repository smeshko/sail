// Polling: each watched workflow's designated, unstarted tickets into its own queue, on its own timer, backing off on
// failure and pausing only that workflow when the provider refuses the credentials.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeCodeHost } from '../../src/adapters/fake/code-host';
import { createFakeTicketSource } from '../../src/adapters/fake/ticket-source';
import type { CodeHost } from '../../src/ports/code-host';
import { PortError } from '../../src/ports/errors';
import type { TicketSource } from '../../src/ports/ticket-source';
import type { PullRequest, Ticket } from '../../src/ports/types';
import { drainCommands, dropCommand } from '../../src/watch/inbox';
import {
  createPoller,
  openWatchTarget,
  pollOnce,
  readWatch,
  readWatches,
  systemTimers,
  type WatchTarget,
} from '../../src/watch/poll';
import { openQueue, type QueueFile, queueDir } from '../../src/watch/queue-store';
import { stubAdapter } from '../helpers/adapters';
import { fakeTimers } from '../helpers/fake-timers';
import { copyFixture, write } from '../helpers/fixture';
import { manualClock, queueEventIssues, queueEvents, ticket } from '../helpers/queue';
import { withTempRepo } from '../helpers/temp-repo';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-poll-'));
  dirs.push(dir);
  return dir;
}

const START = '2026-10-14T09:00:00.000Z';
const STARTED = { type: 'started', name: 'In Progress' } as const;
const CANCELED = { type: 'canceled', name: 'Canceled' } as const;

/** The seed's world: FAKE-1 and FAKE-5 designated and Todo, and one ticket for each way not to be polled. */
const WORLD: Ticket[] = [
  ticket('FAKE-1'),
  ticket('FAKE-2', { state: STARTED }),
  ticket('FAKE-3', { labels: [] }),
  ticket('FAKE-4', { state: CANCELED }),
  ticket('FAKE-5'),
  ticket('FAKE-6', { labels: ['review'] }),
];

/** The fake TicketSource on a temp seed of `WORLD`. */
function fakeSource(dir: string): TicketSource {
  const seed = join(dir, 'tickets.json');
  writeFileSync(seed, JSON.stringify({ tickets: WORLD.map(({ url, raw, ...stored }) => stored) }));
  return createFakeTicketSource({ seed, state: join(dir, 'state.json') });
}

/** `source`, counting its polls, and failing with whatever `failWith` holds while it holds something. */
function counted(source: TicketSource) {
  const counter = {
    calls: 0,
    failWith: undefined as unknown,
    source: {
      ...source,
      listDesignated: async (label: string) => {
        counter.calls += 1;
        if (counter.failWith !== undefined) throw counter.failWith;
        return source.listDesignated(label);
      },
    } as TicketSource,
  };
  return counter;
}

function target(
  runs: string,
  workflow: string,
  label: string,
  source: TicketSource,
  now: () => Date,
  everyMs = 60_000,
) {
  const store = openQueue({ runsDir: runs, workflow, label, now });
  if ('refused' in store) throw new Error(store.refused);
  return {
    workflow,
    kind: 'ticket',
    label,
    everyMs,
    maxConcurrentRuns: 1,
    ticketSource: source,
    codeHost: NO_CODE_HOST,
    store,
  } satisfies WatchTarget;
}

/** The workflow's queue.json, which must exist. */
function queueFile(runs: string, workflow: string): QueueFile {
  const path = join(queueDir(runs, workflow), 'queue.json');
  expect(existsSync(path)).toBe(true);
  return JSON.parse(readFileSync(path, 'utf8'));
}
const itemKeys = (runs: string, workflow: string) => queueFile(runs, workflow).items.map((item) => item.dedupKey);
const events = (runs: string, workflow: string) =>
  queueEvents(queueDir(runs, workflow)).map(({ seq, ts, workflow: _, ...event }) => event);

/** A CodeHost a ticket poll never calls. */
const NO_CODE_HOST = stubAdapter('codeHost') as unknown as CodeHost;

const unauthorized = new PortError('ticketSource', 'listDesignated', 'unauthorized', 'key expired');

test('a poll queues each designated, unstarted ticket once, and a second poll adds nothing', async () => {
  const dir = tempDir();
  const clock = manualClock(START);
  const a = target(dir, 'a', 'sail', fakeSource(dir), clock);
  expect(await pollOnce(a, clock)).toBe('polled');
  expect(await pollOnce(a, clock)).toBe('polled');
  expect(itemKeys(dir, 'a')).toEqual(['ticket:FAKE-1', 'ticket:FAKE-5']);
  expect(events(dir, 'a')).toEqual([
    {
      type: 'queue:item_added',
      dedupKey: 'ticket:FAKE-1',
      source: { kind: 'ticket', ticketKey: 'FAKE-1' },
      title: 'Ticket FAKE-1',
    },
    {
      type: 'queue:item_added',
      dedupKey: 'ticket:FAKE-5',
      source: { kind: 'ticket', ticketKey: 'FAKE-5' },
      title: 'Ticket FAKE-5',
    },
    { type: 'queue:polled', kind: 'ticket', label: 'sail', found: 2, added: 2, durationMs: 0 },
    { type: 'queue:polled', kind: 'ticket', label: 'sail', found: 2, added: 0, durationMs: 0 },
  ]);
  expect(queueEventIssues(queueDir(dir, 'a'))).toEqual([]);
});

test('an adapter that over-answers still queues only designated, unstarted tickets, and an answer that is no ticket list fails the poll as invalid', async () => {
  const dir = tempDir();
  const clock = manualClock(START);
  const fake = fakeSource(dir);
  let answer: unknown = WORLD;
  const source: TicketSource = { ...fake, listDesignated: async () => answer as Ticket[] };
  const a = target(dir, 'a', 'sail', source, clock);
  expect(await pollOnce(a, clock)).toBe('polled');
  expect(itemKeys(dir, 'a')).toEqual(['ticket:FAKE-1', 'ticket:FAKE-5']);
  expect(events(dir, 'a').at(-1)).toMatchObject({ type: 'queue:polled', found: 2, added: 2 });

  answer = [{ ticketKey: 'FAKE-9' }];
  expect(await pollOnce(a, clock)).toBe('failed');
  expect(itemKeys(dir, 'a')).toEqual(['ticket:FAKE-1', 'ticket:FAKE-5']);
  expect(events(dir, 'a').at(-1)).toEqual({
    type: 'queue:error',
    port: 'ticketSource',
    adapter: 'fake',
    code: 'invalid',
    message: expect.stringMatching(/^ticketSource\.listDesignated: the answer is not a list of tickets: 0\./),
    paused: false,
    retryInMs: 60_000,
  });
  expect(queueEventIssues(queueDir(dir, 'a'))).toEqual([]);
});

test('two workflows on one source each queue only their own tickets, in their own queue and events', async () => {
  const dir = tempDir();
  const clock = manualClock(START);
  const source = fakeSource(dir);
  const poller = createPoller({
    targets: [target(dir, 'a', 'sail', source, clock), target(dir, 'b', 'review', source, clock)],
    timers: fakeTimers(START),
    now: clock,
  });
  await poller.start();
  poller.stop();
  expect([itemKeys(dir, 'a'), itemKeys(dir, 'b')]).toEqual([['ticket:FAKE-1', 'ticket:FAKE-5'], ['ticket:FAKE-6']]);
  expect(events(dir, 'b').map((event) => event.dedupKey ?? event.type)).toEqual(['ticket:FAKE-6', 'queue:polled']);
  expect(events(dir, 'a').map((event) => event.dedupKey ?? event.type)).toEqual([
    'ticket:FAKE-1',
    'ticket:FAKE-5',
    'queue:polled',
  ]);
});

test("a 401 pauses only that workflow's timed polls, and a poll command, once the provider answers, clears the pause", async () => {
  const dir = tempDir();
  const timers = fakeTimers(START);
  const fake = fakeSource(dir);
  const a = counted(fake);
  const b = counted(fake);
  a.failWith = unauthorized;
  const poller = createPoller({
    targets: [target(dir, 'a', 'sail', a.source, timers.now), target(dir, 'b', 'review', b.source, timers.now)],
    timers,
    now: timers.now,
  });
  await poller.start();
  expect(events(dir, 'a')).toEqual([
    {
      type: 'queue:error',
      port: 'ticketSource',
      adapter: 'fake',
      code: 'unauthorized',
      message: 'ticketSource.listDesignated: key expired',
      paused: true,
    },
  ]);
  expect(queueFile(dir, 'a').polling.paused).toEqual({
    port: 'ticketSource',
    adapter: 'fake',
    code: 'unauthorized',
    message: 'ticketSource.listDesignated: key expired',
    at: START,
  });
  expect(timers.pending()).toEqual([{ ms: 60_000, due: Date.parse(START) + 60_000 }]);

  await timers.advance(3 * 60_000);
  expect([a.calls, b.calls]).toEqual([1, 4]);

  a.failWith = undefined;
  dropCommand(dir, { op: 'poll', workflow: 'a' });
  expect(await drainCommands(dir, poller.apply)).toEqual({ applied: 1, rejected: [] });
  expect(a.calls).toBe(2);
  expect(await poller.pollNow('a')).toBe('polled');
  expect(a.calls).toBe(2);
  expect(queueFile(dir, 'a').polling).toEqual({ label: 'sail', failures: 0, lastPolledAt: '2026-10-14T09:03:00.000Z' });
  expect(itemKeys(dir, 'a')).toEqual(['ticket:FAKE-1', 'ticket:FAKE-5']);
  expect(timers.pending().map((timer) => timer.ms)).toEqual([60_000, 60_000]);
  await timers.advance(60_000);
  expect([a.calls, b.calls]).toEqual([3, 5]);
  poller.stop();
  expect(() => poller.apply({ op: 'poll', workflow: 'c' })).toThrow("not polling workflow 'c'");
  expect(queueEventIssues(queueDir(dir, 'a'))).toEqual([]);
  expect(queueEventIssues(queueDir(dir, 'b'))).toEqual([]);
});

test('a failing poll backs off by the policy, never under every, a success resets it, and a TypeError counts the same', async () => {
  const dir = tempDir();
  const timers = fakeTimers(START);
  const a = counted(fakeSource(dir));
  a.failWith = new PortError('ticketSource', 'listDesignated', 'unavailable', 'rate limited');
  const poller = createPoller({
    targets: [target(dir, 'a', 'sail', a.source, timers.now, 90_000)],
    timers,
    now: timers.now,
  });
  await poller.start();
  const waits = [timers.pending()[0]?.ms];
  await timers.advance(90_000);
  waits.push(timers.pending()[0]?.ms);
  await timers.advance(120_000);
  waits.push(timers.pending()[0]?.ms);
  expect(waits).toEqual([90_000, 120_000, 300_000]);
  expect(queueFile(dir, 'a').polling.failures).toBe(3);

  a.failWith = undefined;
  await timers.advance(300_000);
  expect(queueFile(dir, 'a').polling.failures).toBe(0);
  expect(timers.pending().map((timer) => timer.ms)).toEqual([90_000]);

  a.failWith = new TypeError('boom');
  await timers.advance(90_000);
  expect(timers.pending().map((timer) => timer.ms)).toEqual([90_000]);
  poller.stop();
  const errors = events(dir, 'a').filter((event) => event.type === 'queue:error');
  expect(errors.map((event) => [event.code, event.retryInMs])).toEqual([
    ['unavailable', 90_000],
    ['unavailable', 120_000],
    ['unavailable', 300_000],
    [undefined, 90_000],
  ]);
  expect(errors.at(-1)).toEqual({
    type: 'queue:error',
    port: 'ticketSource',
    adapter: 'fake',
    message: 'boom',
    paused: false,
    retryInMs: 90_000,
  });
  expect(queueEventIssues(queueDir(dir, 'a'))).toEqual([]);
});

/** A source whose polls wait until the test answers them. */
function onDemand(source: TicketSource) {
  const control = { calls: 0, answer: (_: Ticket[]) => {} };
  const wrapped: TicketSource = {
    ...source,
    listDesignated: () => {
      control.calls += 1;
      return new Promise<Ticket[]>((resolve) => {
        control.answer = resolve;
      });
    },
  };
  return { control, source: wrapped };
}

test("pollNow while the workflow's poll is in flight joins it", async () => {
  const dir = tempDir();
  const timers = fakeTimers(START);
  const { control, source } = onDemand(fakeSource(dir));
  const poller = createPoller({ targets: [target(dir, 'a', 'sail', source, timers.now)], timers, now: timers.now });
  const first = poller.pollNow('a');
  const second = poller.pollNow('a');
  expect(control.calls).toBe(1);
  control.answer([ticket('FAKE-1')]);
  expect(await Promise.all([first, second])).toEqual(['polled', 'polled']);
  expect(control.calls).toBe(1);
  expect(itemKeys(dir, 'a')).toEqual(['ticket:FAKE-1']);
  poller.stop();
});

test('stop clears every timer, and a poll in flight is still recorded but not rescheduled', async () => {
  const dir = tempDir();
  const timers = fakeTimers(START);
  const fake = fakeSource(dir);
  const { control, source } = onDemand(fake);
  let slow = false;
  const a: TicketSource = {
    ...fake,
    listDesignated: (label) => (slow ? source.listDesignated(label) : fake.listDesignated(label)),
  };
  const poller = createPoller({
    targets: [target(dir, 'a', 'sail', a, timers.now), target(dir, 'b', 'review', fake, timers.now)],
    timers,
    now: timers.now,
  });
  await poller.start();
  expect(timers.pending()).toHaveLength(2);
  slow = true;
  const polling = poller.pollNow('a');
  expect(control.calls).toBe(1);
  poller.stop();
  expect(timers.pending()).toEqual([]);
  control.answer([ticket('FAKE-7')]);
  expect(await polling).toBe('polled');
  expect(itemKeys(dir, 'a')).toEqual(['ticket:FAKE-1', 'ticket:FAKE-5', 'ticket:FAKE-7']);
  expect(events(dir, 'a').at(-1)).toMatchObject({ type: 'queue:polled', found: 1, added: 1 });
  expect(timers.pending()).toEqual([]);
});

test('on the system timers, a poller with a 20 ms interval polls at least twice within 500 ms, and stop ends it', async () => {
  const dir = tempDir();
  const a = counted(fakeSource(dir));
  const poller = createPoller({
    targets: [target(dir, 'a', 'sail', a.source, () => new Date(), 20)],
    timers: systemTimers,
    now: () => new Date(),
  });
  await poller.start();
  const deadline = Date.now() + 500;
  while (a.calls < 2 && Date.now() < deadline) await Bun.sleep(5);
  poller.stop();
  expect(a.calls).toBeGreaterThanOrEqual(2);
  const stoppedAt = a.calls;
  await Bun.sleep(60);
  expect(a.calls).toBe(stoppedAt);
});

test("openWatchTarget gives a fixture copy's ticket-to-pr its label, interval and queue, and refuses an unwatched workflow", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    write(
      sail,
      'workflows/plain/workflow.ts',
      "import { workflow } from 'sail';\nimport { ticket } from 'sail/intakes';\n\n" +
        "export default workflow('plain', { intake: ticket }, async () => {});\n",
    );
    const source = createFakeTicketSource({
      seed: join(sail, 'fake', 'tickets.json'),
      state: join(repo.dir, 'state.json'),
    });
    const clock = manualClock(START);
    const options = {
      sailDir: sail,
      config: { label: 'sail' },
      ticketSource: source,
      codeHost: NO_CODE_HOST,
      now: clock,
    };
    const opened = await openWatchTarget({ ...options, name: 'ticket-to-pr' });
    expect(opened).toMatchObject({ workflow: 'ticket-to-pr', label: 'sail', everyMs: 300_000 });
    if ('refused' in opened) throw new Error(opened.refused);
    expect(await pollOnce(opened, clock)).toBe('polled');
    const queue = join(repo.dir, '.sail-runs', 'queue', 'ticket-to-pr');
    expect(existsSync(join(queue, 'queue.json'))).toBe(true);
    expect(itemKeys(join(repo.dir, '.sail-runs'), 'ticket-to-pr')).toEqual(['ticket:FAKE-1']);
    expect(queueEventIssues(queue)).toEqual([]);
    expect(await openWatchTarget({ ...options, name: 'plain' })).toEqual({
      refused: "workflow 'plain' isn't watched: it declares no watch",
    });
  });
});

/** `target`'s store, whose writes throw while `failing` holds, as on a full disk. */
function failingWrites(polled: WatchTarget) {
  const control = { failing: true };
  const fail = () => {
    if (control.failing) throw new Error('ENOSPC: no space left on device, write');
  };
  const { store } = polled;
  return {
    control,
    target: {
      ...polled,
      store: {
        ...store,
        add(tickets: readonly Ticket[]) {
          fail();
          return store.add(tickets);
        },
        polled(poll: Parameters<typeof store.polled>[0]) {
          fail();
          store.polled(poll);
        },
        pollFailed(failure: Parameters<typeof store.pollFailed>[0]) {
          fail();
          store.pollFailed(failure);
        },
      },
    } satisfies WatchTarget,
  };
}

test('a poll whose queue write throws rejects its caller, retries at the backoff, and polls again once writes recover (review #1.1)', async () => {
  const dir = tempDir();
  const timers = fakeTimers(START);
  const a = counted(fakeSource(dir));
  const { control, target: failing } = failingWrites(target(dir, 'a', 'sail', a.source, timers.now, 30_000));
  const heard: [string, string][] = [];
  const poller = createPoller({
    targets: [failing],
    timers,
    now: timers.now,
    onError: (workflow, error) => heard.push([workflow, (error as Error).message]),
  });
  await expect(poller.pollNow('a')).rejects.toThrow('ENOSPC');
  expect(timers.pending().map((timer) => timer.ms)).toEqual([60_000]);
  await timers.advance(60_000);
  expect(a.calls).toBe(2);
  expect(heard).toEqual([['a', 'ENOSPC: no space left on device, write']]);
  control.failing = false;
  await timers.advance(60_000);
  expect(a.calls).toBe(3);
  expect(itemKeys(dir, 'a')).toEqual(['ticket:FAKE-1', 'ticket:FAKE-5']);
  expect(await poller.pollNow('a')).toBe('polled');
  expect(a.calls).toBe(4);
  expect(timers.pending().map((timer) => timer.ms)).toEqual([30_000]);
  poller.stop();
});

test('a poll command or a start whose poll throws reports it to onError, or to stderr without one, and rejects nothing (review #1.2)', async () => {
  const dir = tempDir();
  const timers = fakeTimers(START);
  const a = counted(fakeSource(dir));
  const { target: failing } = failingWrites(target(dir, 'a', 'sail', a.source, timers.now));
  const heard: string[] = [];
  const poller = createPoller({
    targets: [failing],
    timers,
    now: timers.now,
    onError: (workflow, error) => heard.push(`${workflow}: ${(error as Error).message}`),
  });
  await poller.start();
  dropCommand(dir, { op: 'poll', workflow: 'a' });
  expect(await drainCommands(dir, poller.apply)).toEqual({ applied: 1, rejected: [] });
  await Bun.sleep(0);
  expect(heard).toEqual(['a: ENOSPC: no space left on device, write', 'a: ENOSPC: no space left on device, write']);
  poller.stop();

  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((text: string) => {
    written.push(text);
    return true;
  }) as typeof process.stderr.write;
  try {
    const quiet = createPoller({ targets: [failing], timers, now: timers.now });
    await quiet.start();
    quiet.stop();
  } finally {
    process.stderr.write = write;
  }
  expect(written).toEqual(["sail: polling workflow 'a' failed: ENOSPC: no space left on device, write\n"]);
});

test('a paused workflow whose poll command fails otherwise is no longer paused, backs off, and a 401 pauses it again (review #1.7)', async () => {
  const dir = tempDir();
  const timers = fakeTimers(START);
  const a = counted(fakeSource(dir));
  a.failWith = unauthorized;
  const poller = createPoller({ targets: [target(dir, 'a', 'sail', a.source, timers.now)], timers, now: timers.now });
  await poller.start();
  expect(queueFile(dir, 'a').polling.paused).toMatchObject({ code: 'unauthorized' });
  expect(timers.pending()).toEqual([]);

  a.failWith = new PortError('ticketSource', 'listDesignated', 'unavailable', 'bad gateway');
  expect(await poller.pollNow('a')).toBe('failed');
  expect(queueFile(dir, 'a').polling).toEqual({ label: 'sail', failures: 1 });
  expect(timers.pending().map((timer) => timer.ms)).toEqual([60_000]);

  a.failWith = unauthorized;
  await timers.advance(60_000);
  expect(queueFile(dir, 'a').polling.paused).toMatchObject({ code: 'unauthorized' });
  expect(timers.pending()).toEqual([]);
  poller.stop();
});

test('an answer holding a ticket with an empty key fails the poll as invalid, and the queue still opens (review #2.2)', async () => {
  const dir = tempDir();
  const clock = manualClock(START);
  const fake = fakeSource(dir);
  const source: TicketSource = { ...fake, listDesignated: async () => [ticket('FAKE-1'), ticket('')] };
  const a = target(dir, 'a', 'sail', source, clock);
  expect(await pollOnce(a, clock)).toBe('failed');
  expect(queueFile(dir, 'a').items).toEqual([]);
  expect(events(dir, 'a')).toEqual([
    {
      type: 'queue:error',
      port: 'ticketSource',
      adapter: 'fake',
      code: 'invalid',
      message: expect.stringMatching(
        /^ticketSource\.listDesignated: the answer is not a list of tickets: 1\.ticketKey /,
      ),
      paused: false,
      retryInMs: 60_000,
    },
  ]);
  expect('refused' in openQueue({ runsDir: dir, workflow: 'a', label: 'sail', now: clock })).toBe(false);
  expect(queueEventIssues(queueDir(dir, 'a'))).toEqual([]);
});

test('a pause saved to queue.json whose queue:error append throws still stops timed polls (review #2.4)', async () => {
  const dir = tempDir();
  const timers = fakeTimers(START);
  const a = counted(fakeSource(dir));
  a.failWith = unauthorized;
  const polled = target(dir, 'a', 'sail', a.source, timers.now);
  const { store } = polled;
  const savedThenThrows: WatchTarget = {
    ...polled,
    store: {
      ...store,
      pollFailed(failure) {
        store.pollFailed(failure);
        throw new Error('ENOSPC: no space left on device, write');
      },
    },
  };
  const heard: string[] = [];
  const poller = createPoller({
    targets: [savedThenThrows],
    timers,
    now: timers.now,
    onError: (workflow) => heard.push(workflow),
  });
  await poller.start();
  expect(heard).toEqual(['a']);
  expect(queueFile(dir, 'a').polling.paused).toMatchObject({ code: 'unauthorized' });
  expect(timers.pending()).toEqual([]);
  await timers.advance(60 * 60_000);
  expect(a.calls).toBe(1);
  poller.stop();
});

test("readWatch gives a fixture copy's ticket-to-pr its label, interval and cap without opening its queue, and openWatchTarget carries the cap", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const options = { sailDir: sail, config: { label: 'sail' }, name: 'ticket-to-pr' };
    expect(await readWatch(options)).toEqual({
      workflow: 'ticket-to-pr',
      kind: 'ticket',
      label: 'sail',
      everyMs: 300_000,
      maxConcurrentRuns: 2,
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
    const source = createFakeTicketSource({
      seed: join(sail, 'fake', 'tickets.json'),
      state: join(repo.dir, 'state.json'),
    });
    const opened = await openWatchTarget({
      ...options,
      ticketSource: source,
      codeHost: NO_CODE_HOST,
      now: manualClock(START),
    });
    expect('refused' in opened ? opened : opened.maxConcurrentRuns).toBe(2);
  });
});

test("readWatches gives a fixture copy's ticket-to-pr and skips review, and refuses naming a workflow that won't load", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    expect(await readWatches({ sailDir: sail, config: { label: 'sail' } })).toEqual({
      watches: [{ workflow: 'ticket-to-pr', kind: 'ticket', label: 'sail', everyMs: 300_000, maxConcurrentRuns: 2 }],
    });
    write(sail, 'workflows/broken/workflow.ts', 'export default 1;\n');
    const refused = await readWatches({ sailDir: sail, config: { label: 'sail' } });
    expect(refused).toEqual({ refused: expect.stringContaining('workflows/broken/workflow.ts') });
    expect('refused' in refused ? refused.refused : '').toContain('default-exports no workflow');
  });
});

// Pull requests (14.2's D9): a watched workflow on the `pr` intake polls the CodeHost, one queue item per head sha.

/** The fake CodeHost's world: 1 designated, 2 a draft, 3 closed and 4 unlabelled, each from a branch of its own. */
const PULLS = [
  { number: 1, draft: false, state: 'open', labels: ['sail'] },
  { number: 2, draft: true, state: 'open', labels: ['sail'] },
  { number: 3, draft: false, state: 'closed', labels: ['sail'] },
  { number: 4, draft: false, state: 'open', labels: [] },
].map((pr) => ({
  ...pr,
  title: `Pull request ${pr.number}`,
  body: '',
  base: 'main',
  head: `sail/FAKE-${pr.number}-x`,
  headSha: `${pr.number}`.repeat(40),
}));

/** The fake CodeHost on a temp seed of `PULLS`, and its state file, which a test edits to move a head. */
function fakeHost(dir: string): { host: CodeHost; state: string } {
  const seed = join(dir, 'prs.json');
  const world = {
    remote: 'fake://codehost/stub',
    defaultBranch: 'main',
    branches: { main: 'a'.repeat(40) },
    pullRequests: PULLS,
  };
  writeFileSync(seed, JSON.stringify(world));
  const state = join(dir, 'prs-state.json');
  return { host: createFakeCodeHost({ seed, state }), state };
}

/** A watched `pr` workflow, `r`, on `host`. */
function prTarget(runs: string, host: CodeHost, now: () => Date): WatchTarget {
  const store = openQueue({ runsDir: runs, workflow: 'r', label: 'sail', now });
  if ('refused' in store) throw new Error(store.refused);
  const ticketSource = stubAdapter('ticketSource') as unknown as TicketSource;
  return {
    workflow: 'r',
    kind: 'pr',
    label: 'sail',
    everyMs: 60_000,
    maxConcurrentRuns: 1,
    ticketSource,
    codeHost: host,
    store,
  };
}

test("a pr workflow's poll queues the designated pull request as pr:<number>@<sha7>, and not the draft, the closed or the unlabelled one", async () => {
  const dir = tempDir();
  const clock = manualClock(START);
  const r = prTarget(dir, fakeHost(dir).host, clock);
  expect(await pollOnce(r, clock)).toBe('polled');
  expect({ keys: itemKeys(dir, 'r'), events: events(dir, 'r'), issues: queueEventIssues(queueDir(dir, 'r')) }).toEqual({
    keys: ['pr:1@1111111'],
    events: [
      {
        type: 'queue:item_added',
        dedupKey: 'pr:1@1111111',
        source: { kind: 'pr', number: 1, headSha: '1'.repeat(40), branch: 'sail/FAKE-1-x' },
        title: 'Pull request 1',
      },
      { type: 'queue:polled', kind: 'pr', label: 'sail', found: 1, added: 1, durationMs: 0 },
    ],
    issues: [],
  });
});

test('a new head sha is a new item beside the old one, and a sha already queued is never queued again, even once its item is done', async () => {
  const dir = tempDir();
  const clock = manualClock(START);
  const { host, state } = fakeHost(dir);
  const r = prTarget(dir, host, clock);
  await pollOnce(r, clock);
  expect(itemKeys(dir, 'r')).toEqual(['pr:1@1111111']);
  r.store.done('pr:1@1111111');
  await pollOnce(r, clock);
  const again = r.store.snapshot().items.map((item) => `${item.dedupKey} ${item.state}`);
  const moved = PULLS.map((pr) => (pr.number === 1 ? { ...pr, headSha: 'b'.repeat(40) } : pr));
  writeFileSync(
    state,
    JSON.stringify({ remote: 'fake://codehost/stub', defaultBranch: 'main', branches: {}, pullRequests: moved }),
  );
  await pollOnce(r, clock);
  expect({
    again,
    after: r.store.snapshot().items.map((item) => `${item.dedupKey} ${item.state}`),
    added: events(dir, 'r')
      .filter((event) => event.type === 'queue:polled')
      .map((event) => event.added),
  }).toEqual({
    again: ['pr:1@1111111 done'],
    after: ['pr:1@1111111 done', 'pr:1@bbbbbbb queued'],
    added: [1, 0, 1],
  });
});

test("a CodeHost of the repository's own that answers a draft, a closed and an unlabelled pull request beside the designated one queues only the designated one", async () => {
  const dir = tempDir();
  const clock = manualClock(START);
  const { host } = fakeHost(dir);
  const answer: PullRequest[] = await Promise.all(PULLS.map((pr) => host.getPullRequest(pr.number)));
  const r = prTarget(dir, { ...host, listDesignated: async () => answer }, clock);
  expect(await pollOnce(r, clock)).toBe('polled');
  expect(itemKeys(dir, 'r')).toEqual(['pr:1@1111111']);
});

test('a pull request labelled in another case than the poll label is queued', async () => {
  const dir = tempDir();
  const clock = manualClock(START);
  const { host } = fakeHost(dir);
  const cased = { ...(await host.getPullRequest(1)), labels: ['Sail'] };
  const r = prTarget(dir, { ...host, listDesignated: async () => [cased] }, clock);
  expect(await pollOnce(r, clock)).toBe('polled');
  expect({
    keys: itemKeys(dir, 'r'),
    polled: events(dir, 'r').filter((event) => event.type === 'queue:polled'),
  }).toEqual({
    keys: ['pr:1@1111111'],
    polled: [{ type: 'queue:polled', kind: 'pr', label: 'sail', found: 1, added: 1, durationMs: 0 }],
  });
});

test("an answer that is no list of pull requests fails a pr workflow's poll as the codeHost's invalid, and a codeHost that refuses the credentials pauses it", async () => {
  const dir = tempDir();
  const clock = manualClock(START);
  const { host } = fakeHost(dir);
  const odd = prTarget(dir, { ...host, name: 'odd', listDesignated: async () => ({ nope: true }) as never }, clock);
  const failed = await pollOnce(odd, clock);
  const refusing = {
    ...host,
    name: 'refusing',
    listDesignated: async (): Promise<PullRequest[]> => {
      throw new PortError('codeHost', 'listDesignated', 'unauthorized', 'bad token');
    },
  };
  const paused = await pollOnce(prTarget(join(dir, 'other'), refusing, clock), clock);
  const error = events(dir, 'r').find((event) => event.type === 'queue:error');
  expect({
    failed,
    error: error === undefined ? undefined : [error.port, error.adapter, error.code],
    paused,
    pause: queueFile(join(dir, 'other'), 'r').polling.paused,
  }).toEqual({
    failed: 'failed',
    error: ['codeHost', 'odd', 'invalid'],
    paused: 'paused',
    pause: {
      port: 'codeHost',
      adapter: 'refusing',
      code: 'unauthorized',
      message: 'codeHost.listDesignated: bad token',
      at: START,
    },
  });
});

test('with pickUp [Todo], a poll queues the labelled Todo ticket and skips the labelled Backlog one', async () => {
  const dir = tempDir();
  const seed = join(dir, 'tickets.json');
  const world = [ticket('FAKE-1'), ticket('FAKE-2', { state: { type: 'unstarted', name: 'Backlog' } })];
  writeFileSync(seed, JSON.stringify({ tickets: world.map(({ url, raw, ...stored }) => stored) }));
  const source = createFakeTicketSource({ seed, state: join(dir, 'state.json'), pickUp: ['Todo'] });
  const clock = manualClock(START);
  const a = target(dir, 'a', 'sail', source, clock);
  expect(await pollOnce(a, clock)).toBe('polled');
  expect(itemKeys(dir, 'a')).toEqual(['ticket:FAKE-1']);
});

test('an adapter that over-answers a Backlog ticket under pickUp [Todo] has it filtered by canPickUp', async () => {
  const dir = tempDir();
  const seed = join(dir, 'tickets.json');
  const world = [ticket('FAKE-1'), ticket('FAKE-2', { state: { type: 'unstarted', name: 'Backlog' } })];
  writeFileSync(seed, JSON.stringify({ tickets: world.map(({ url, raw, ...stored }) => stored) }));
  const fake = createFakeTicketSource({ seed, state: join(dir, 'state.json'), pickUp: ['Todo'] });
  const clock = manualClock(START);
  const a = target(dir, 'a', 'sail', { ...fake, listDesignated: async () => world }, clock);
  await pollOnce(a, clock);
  expect(itemKeys(dir, 'a')).toEqual(['ticket:FAKE-1']);
});

test('a second poll that finds a queued ticket at a higher priority updates its priority and moves it, counting it found and not added', async () => {
  const dir = tempDir();
  const clock = manualClock(START);
  const seeded = fakeSource(dir);
  let answer: Ticket[] = [ticket('FAKE-1'), ticket('FAKE-5')];
  const source = { ...seeded, listDesignated: async () => answer } as TicketSource;
  const a = target(dir, 'a', 'sail', source, clock);
  await pollOnce(a, clock);
  answer = [ticket('FAKE-1'), ticket('FAKE-5', { priority: 'urgent' })];
  await pollOnce(a, clock);
  expect(itemKeys(dir, 'a')).toEqual(['ticket:FAKE-5', 'ticket:FAKE-1']);
  expect(queueFile(dir, 'a').items.map((item) => item.priority)).toEqual(['urgent', undefined]);
  expect(
    events(dir, 'a')
      .filter((event) => event.type === 'queue:polled')
      .map((event) => [event.found, event.added]),
  ).toEqual([
    [2, 2],
    [2, 0],
  ]);
});
