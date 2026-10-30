// One workflow's dispatch (DECISIONS D6-D9): settle the items whose run has ended, then start due items within the
// cap, skipping a leased branch without a slot or an attempt, and dropping an item no longer eligible. On the stub's
// file-backed fakes in a temp repository, a hand-moved clock and a fake spawner.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createFakeTicketSource } from '../../src/adapters/fake/ticket-source';
import { branchFor } from '../../src/engine/branch';
import { requestStop, requestUnwatch } from '../../src/engine/control';
import { writeStatus } from '../../src/engine/run-dir';
import { claimComment } from '../../src/engine/source';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { CodeHost } from '../../src/ports/code-host';
import { PortError } from '../../src/ports/errors';
import type { TicketSource } from '../../src/ports/ticket-source';
import type { PullRequestDetails } from '../../src/ports/types';
import type { WorkspacePort } from '../../src/ports/workspace';
import { createDispatcher, type Settled } from '../../src/watch/dispatch';
import { openQueue, type QueueStore, queueDir } from '../../src/watch/queue-store';
import { dispatchLog, spawnRun } from '../../src/watch/spawn';
import { fakeAdapters } from '../helpers/adapters';
import { commitBranch, seedPullRequests } from '../helpers/pr-workflow';
import { manualClock, queueEventIssues, queueEvents, sourceKey, ticket } from '../helpers/queue';
import { sharedSource } from '../helpers/seeded';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';
import { FAKE_PID, type FakeSpawner, fakeSpawner, writeTickets } from '../helpers/watched';

const START = '2026-10-15T09:00:00.000Z';
const FIVE_MINUTES = 5 * 60_000;
const BACKOFF = 15 * 60_000;

/** FAKE-1 to FAKE-n, designated and Todo. */
const designated = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ key: `FAKE-${index + 1}`, labels: ['sail'] }));

interface World {
  runs: string;
  clock: ReturnType<typeof manualClock>;
  store: QueueStore;
  ticketSource: TicketSource;
  adapters: Awaited<ReturnType<typeof fakeAdapters>>;
  spawner: FakeSpawner;
  settled: Settled[];
  errors: string[];
  dispatcher: (store?: QueueStore) => ReturnType<typeof createDispatcher>;
}

/**
 * The stub with `count` designated tickets, all queued in workflow `a`'s queue, and a dispatcher of `a` at `cap`.
 * `claiming` runs claim their ticket as they start; `source` stands in for the ticket source the dispatch re-checks with.
 */
async function world(
  repo: TempRepo,
  count: number,
  cap: number,
  options: {
    claiming?: boolean;
    source?: (own: TicketSource) => TicketSource;
    workspace?: (own: WorkspacePort) => WorkspacePort;
    paused?: () => boolean;
  } = {},
): Promise<World> {
  writeTickets(writeStub(repo.dir), designated(count));
  const adapters = await fakeAdapters(repo.dir);
  const runs = join(repo.dir, '.sail-runs');
  const clock = manualClock(START);
  const opened = () => {
    const store = openQueue({ runsDir: runs, workflow: 'a', label: 'sail', now: clock });
    if ('refused' in store) throw new Error(store.refused);
    return store;
  };
  const store = opened();
  const own = adapters.ports.ticketSource;
  store.add(await own.listDesignated('sail'));
  const ticketSource = options.source?.(own) ?? own;
  const spawner = fakeSpawner(runs, options.claiming === false ? undefined : own);
  const settled: Settled[] = [];
  const errors: string[] = [];
  const workspace = options.workspace?.(adapters.ports.workspace) ?? adapters.ports.workspace;
  const dispatcher = (on: QueueStore = store) =>
    createDispatcher({
      workflow: 'a',
      label: 'sail',
      maxConcurrentRuns: cap,
      branchPrefix: 'sail/',
      runsDir: runs,
      root: repo.dir,
      store: on,
      ticketSource,
      codeHost: adapters.ports.codeHost,
      workspace,
      env: repo.env,
      now: clock,
      usageLimitBackoffMs: BACKOFF,
      spawn: spawner.spawn,
      resume: spawner.resume,
      isAlive: spawner.isAlive,
      onSettled: (each) => settled.push(each),
      onError: (message) => errors.push(message),
      ...(options.paused === undefined ? {} : { paused: options.paused }),
    });
  return { runs, clock, store, ticketSource, adapters, spawner, settled, errors, dispatcher };
}

const spawnedKeys = (spawner: FakeSpawner) => spawner.runs.map((run) => run.ticketKey);
const states = (store: QueueStore) =>
  store.snapshot().items.map((item) => `${sourceKey(item)} ${item.state} ${item.attempts}`);
const eventsOf = (runs: string, type: string) =>
  queueEvents(queueDir(runs, 'a'))
    .filter((event) => event.type === type)
    .map(({ seq, ts, workflow, type: _, ...rest }) => rest);

/** Leases `ticketKey`'s branch to a run started by hand: this process, with a run directory that has no STATUS yet. */
async function leaseByHand(w: World, ticketKey: string) {
  const { workspace } = w.adapters.ports;
  const { url } = await workspace.repository();
  const branch = branchFor('sail/', ticketKey, `Ticket ${ticketKey}`);
  const holder = {
    runId: `${ticketKey}-01M3BWNZM08Q4T6V2XRJ5KWD3N`,
    runDir: join(w.runs, 'by-hand'),
    pid: process.pid,
  };
  const leased = await workspace.lease(url, branch, holder);
  expect(leased.leased).toBe(true);
  return { branch, holder, release: () => workspace.releaseLease(url, branch, holder.runId) };
}

test('a cap of 2 starts the first two due items in queue order, and once one completes the next tick settles it done and starts the third', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 4, 2);
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    expect([spawnedKeys(w.spawner), dispatcher.inFlight()]).toEqual([['FAKE-1', 'FAKE-2'], 2]);
    await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-1', 'FAKE-2']);
    expect(w.store.snapshot().items[0]).toMatchObject({
      state: 'dispatched',
      attempts: 1,
      runId: w.spawner.run('FAKE-1').runId,
      pid: w.spawner.run('FAKE-1').pid,
    });
    await w.spawner.end('FAKE-1');
    await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-1', 'FAKE-2', 'FAKE-3']);
    expect(states(w.store)).toEqual(['FAKE-1 done 1', 'FAKE-2 dispatched 1', 'FAKE-3 dispatched 1', 'FAKE-4 queued 0']);
    const run1 = w.spawner.run('FAKE-1').runId;
    expect(w.settled).toEqual([{ dedupKey: 'ticket:FAKE-1', ticketKey: 'FAKE-1', runId: run1, outcome: 'done' }]);
    expect(eventsOf(w.runs, 'queue:dispatched').map((event) => event.dedupKey)).toEqual([
      'ticket:FAKE-1',
      'ticket:FAKE-2',
      'ticket:FAKE-3',
    ]);
    expect(queueEventIssues(queueDir(w.runs, 'a'))).toEqual([]);
  });
});

test('a due item whose branch a live run leases waits with its attempts, says so once across ticks, gives its slot to the next, and starts once released', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 2, 2);
    const byHand = await leaseByHand(w, 'FAKE-1');
    const dispatcher = w.dispatcher();
    for (let tick = 0; tick < 3; tick += 1) await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-2']);
    expect(states(w.store)).toEqual(['FAKE-1 queued 0', 'FAKE-2 dispatched 1']);
    expect(eventsOf(w.runs, 'queue:skipped_leased')).toEqual([
      { dedupKey: 'ticket:FAKE-1', branch: byHand.branch, heldBy: byHand.holder.runId },
    ]);
    await byHand.release();
    await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-2', 'FAKE-1']);
    expect(states(w.store)).toEqual(['FAKE-1 dispatched 1', 'FAKE-2 dispatched 1']);
    expect(queueEventIssues(queueDir(w.runs, 'a'))).toEqual([]);
  });
});

test('a ticket that became In Progress, or lost its label, since it was queued is dropped with its reason and never spawned', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 3, 3);
    const state = join(repo.dir, '.sail-runs', 'fake', 'tickets.json');
    const seed = JSON.parse(readFileSync(join(repo.dir, '.sail', 'fake', 'tickets.json'), 'utf8'));
    seed.tickets[1].labels = [];
    mkdirSync(join(repo.dir, '.sail-runs', 'fake'), { recursive: true });
    writeFileSync(state, JSON.stringify(seed));
    expect((await w.ticketSource.claim('FAKE-1')).claimed).toBe(true);
    await w.dispatcher().tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-3']);
    expect(states(w.store)).toEqual(['FAKE-3 dispatched 1']);
    expect(eventsOf(w.runs, 'queue:dropped')).toEqual([
      { dedupKey: 'ticket:FAKE-1', reason: 'it is In Progress' },
      { dedupKey: 'ticket:FAKE-2', reason: "it is not designated: it carries no 'sail' label" },
    ]);
    expect(queueEventIssues(queueDir(w.runs, 'a'))).toEqual([]);
  });
});

test('a ticket the re-check no longer finds is dropped as no longer existing, never spawned or retried, and the next due item starts in the same tick', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 2, 2, {
      source: (own) => ({
        ...own,
        get: (ticketKey: string) => {
          if (ticketKey === 'FAKE-1') throw new PortError('ticketSource', 'get', 'not_found', 'no ticket FAKE-1');
          return own.get(ticketKey);
        },
      }),
    });
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-2']);
    expect(states(w.store)).toEqual(['FAKE-2 dispatched 1']);
    expect(eventsOf(w.runs, 'queue:dropped')).toEqual([
      { dedupKey: 'ticket:FAKE-1', reason: 'it no longer exists: ticketSource.get: no ticket FAKE-1' },
    ]);
    expect(w.settled).toEqual([]);
    w.clock.advance(FIVE_MINUTES);
    await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-2']);
    expect(queueEventIssues(queueDir(w.runs, 'a'))).toEqual([]);
  });
});

test('a re-check the ticket source fails leaves the item failed with no attempt, due again after the first retry delay, and the rest for the next tick', async () => {
  await withTempRepo(async (repo) => {
    let down = true;
    const w = await world(repo, 2, 2, {
      source: (own) => ({
        ...own,
        get: (ticketKey: string) => {
          if (down) throw new PortError('ticketSource', 'get', 'unavailable', 'bad gateway');
          return own.get(ticketKey);
        },
      }),
    });
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual([]);
    expect(states(w.store)).toEqual(['FAKE-1 failed 0', 'FAKE-2 queued 0']);
    expect(w.store.snapshot().items[0]).toMatchObject({
      reason: 'ticketSource.get: bad gateway (unavailable)',
      retryAt: new Date(Date.parse(START) + FIVE_MINUTES).toISOString(),
    });
    down = false;
    w.clock.advance(FIVE_MINUTES - 1);
    expect(w.store.due().map(sourceKey)).toEqual(['FAKE-2']);
    w.clock.advance(1);
    await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-1', 'FAKE-2']);
  });
});

test("a run that failed fails its item with the stop reason and parks it on the second, and a start refused before its run directory fails it with its log's last line", async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 2, 2, { claiming: false });
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-1', 'FAKE-2']);
    const first = w.spawner.run('FAKE-1').runId;
    await w.spawner.end('FAKE-1', { status: 'failed', stopReason: 'stage_error' });
    await w.spawner.end('FAKE-2', { refused: 'sail FAKE-2: the branch sail/FAKE-2-ticket-fake-2 is leased by run X' });
    await dispatcher.tick();
    const refused = 'its start was refused: sail FAKE-2: the branch sail/FAKE-2-ticket-fake-2 is leased by run X';
    expect(w.store.snapshot().items.map(({ state, attempts, reason }) => ({ state, attempts, reason }))).toEqual([
      { state: 'failed', attempts: 1, reason: `run ${first} failed (stage_error)` },
      { state: 'failed', attempts: 1, reason: refused },
    ]);
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-1', 'FAKE-2']);

    w.clock.advance(FIVE_MINUTES);
    await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-1', 'FAKE-2', 'FAKE-1', 'FAKE-2']);
    const second = w.spawner.run('FAKE-1').runId;
    await w.spawner.end('FAKE-1', { status: 'failed', stopReason: 'workflow_failed' });
    await dispatcher.tick();
    expect(states(w.store)).toEqual(['FAKE-1 parked 2', 'FAKE-2 dispatched 2']);
    expect(eventsOf(w.runs, 'queue:parked')).toEqual([
      { dedupKey: 'ticket:FAKE-1', attempts: 2, reason: `run ${second} failed (workflow_failed)` },
    ]);
    expect(w.settled.map(({ ticketKey, outcome }) => `${ticketKey} ${outcome}`)).toEqual([
      'FAKE-1 retry',
      'FAKE-2 retry',
      'FAKE-1 parked',
    ]);
    expect(queueEventIssues(queueDir(w.runs, 'a'))).toEqual([]);
  });
});

test('a paused dispatch starts and resumes nothing but still settles what ended, and once unpaused it starts and resumes as before', async () => {
  await withTempRepo(async (repo) => {
    let paused = false;
    const w = await world(repo, 3, 2, { paused: () => paused });
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    paused = true;
    await w.spawner.end('FAKE-1');
    await w.spawner.end('FAKE-2', { status: 'suspended', stopReason: 'interrupted' });
    await dispatcher.tick();
    const whilePaused = { spawned: spawnedKeys(w.spawner), resumes: w.spawner.resumes.length, states: states(w.store) };
    paused = false;
    await dispatcher.tick();
    expect({
      whilePaused,
      after: { spawned: spawnedKeys(w.spawner), resumes: w.spawner.resumes.length, states: states(w.store) },
    }).toEqual({
      whilePaused: {
        spawned: ['FAKE-1', 'FAKE-2'],
        resumes: 0,
        states: ['FAKE-1 done 1', 'FAKE-2 dispatched 1', 'FAKE-3 queued 0'],
      },
      after: {
        spawned: ['FAKE-1', 'FAKE-2', 'FAKE-3'],
        resumes: 1,
        states: ['FAKE-1 done 1', 'FAKE-2 dispatched 1', 'FAKE-3 dispatched 1'],
      },
    });
  });
});

test('a run whose process is gone while it reads suspended interrupted or running is resumed once, with run:resumed saying where it was, and its resume holds the slot', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 3, 2);
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-1', 'FAKE-2']);
    await w.spawner.end('FAKE-1', { status: 'suspended', stopReason: 'interrupted' });
    await w.spawner.end('FAKE-2', { status: 'running' });
    await dispatcher.tick();
    await dispatcher.tick();
    const run1 = w.spawner.run('FAKE-1').runId;
    const run2 = w.spawner.run('FAKE-2').runId;
    expect({
      spawned: spawnedKeys(w.spawner),
      resumes: w.spawner.resumes.map(({ runId, pid }) => [runId, pid]),
      items: w.store.snapshot().items.map((item) => [sourceKey(item), item.state, item.attempts, item.pid]),
      inFlight: dispatcher.inFlight(),
      resumed: eventsOf(w.runs, 'run:resumed'),
      settled: w.settled,
      issues: queueEventIssues(queueDir(w.runs, 'a')),
    }).toEqual({
      spawned: ['FAKE-1', 'FAKE-2'],
      resumes: [
        [run1, FAKE_PID + 2],
        [run2, FAKE_PID + 3],
      ],
      items: [
        ['FAKE-1', 'dispatched', 1, FAKE_PID + 2],
        ['FAKE-2', 'dispatched', 1, FAKE_PID + 3],
        ['FAKE-3', 'queued', 0, undefined],
      ],
      inFlight: 2,
      resumed: [
        {
          dedupKey: 'ticket:FAKE-1',
          run: run1,
          pid: FAKE_PID + 2,
          from: { status: 'suspended', stopReason: 'interrupted' },
        },
        { dedupKey: 'ticket:FAKE-2', run: run2, pid: FAKE_PID + 3, from: { status: 'running' } },
      ],
      settled: [],
      issues: [],
    });
  });
});

test('a run suspended on the usage limit holds the workflow: nothing starts and an interrupted run is not resumed, no attempt is counted and nothing is parked; past the hold, queue:released, the runs are resumed and the queued item starts', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 4, 3);
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    await w.spawner.end('FAKE-1', { status: 'suspended', stopReason: 'usage_limit' });
    await w.spawner.end('FAKE-2', { status: 'suspended', stopReason: 'interrupted' });
    await w.spawner.end('FAKE-3');
    await dispatcher.tick();
    await dispatcher.tick();
    const held = {
      spawned: spawnedKeys(w.spawner),
      resumes: w.spawner.resumes.length,
      items: w.store.snapshot().items.map((item) => [sourceKey(item), item.state, item.attempts]),
      held: eventsOf(w.runs, 'queue:held').map(({ until, run, reason }) => ({ until, run, reason })),
      settled: w.settled,
    };
    w.clock.advance(16 * 60_000);
    await dispatcher.tick();
    const run1 = w.spawner.run('FAKE-1').runId;
    expect({
      held,
      after: {
        spawned: spawnedKeys(w.spawner),
        resumes: w.spawner.resumes.map(({ runId }) => runId),
        released: eventsOf(w.runs, 'queue:released').length,
        resumed: eventsOf(w.runs, 'run:resumed').map(({ dedupKey, from }) => [dedupKey, from]),
        stillHeld: w.store.snapshot().held,
        items: w.store.snapshot().items.map((item) => [sourceKey(item), item.state, item.attempts]),
      },
      issues: queueEventIssues(queueDir(w.runs, 'a')),
    }).toEqual({
      held: {
        spawned: ['FAKE-1', 'FAKE-2', 'FAKE-3'],
        resumes: 0,
        items: [
          ['FAKE-1', 'dispatched', 1],
          ['FAKE-2', 'dispatched', 1],
          ['FAKE-3', 'done', 1],
          ['FAKE-4', 'queued', 0],
        ],
        held: [{ until: '2026-10-15T09:15:00.000Z', run: run1, reason: 'a run hit the usage limit' }],
        settled: [
          { dedupKey: 'ticket:FAKE-3', ticketKey: 'FAKE-3', runId: w.spawner.run('FAKE-3').runId, outcome: 'done' },
        ],
      },
      after: {
        spawned: ['FAKE-1', 'FAKE-2', 'FAKE-3', 'FAKE-4'],
        resumes: [run1, w.spawner.run('FAKE-2').runId],
        released: 1,
        resumed: [
          ['ticket:FAKE-1', { status: 'suspended', stopReason: 'usage_limit' }],
          ['ticket:FAKE-2', { status: 'suspended', stopReason: 'interrupted' }],
        ],
        stillHeld: undefined,
        items: [
          ['FAKE-1', 'dispatched', 1],
          ['FAKE-2', 'dispatched', 1],
          ['FAKE-3', 'done', 1],
          ['FAKE-4', 'dispatched', 1],
        ],
      },
      issues: [],
    });
  });
});

test('a resumed run that hits the usage limit again is held again and resumed again past it; one whose resume left it on the same limit is parked; and once held again, it is not a run this dispatcher resumed', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 2, 2);
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    await w.spawner.end('FAKE-1', { status: 'suspended', stopReason: 'usage_limit' });
    await w.spawner.end('FAKE-2', { status: 'suspended', stopReason: 'usage_limit' });
    await dispatcher.tick();
    w.clock.advance(16 * 60_000);
    await dispatcher.tick();
    const [run1, run2] = [w.spawner.run('FAKE-1').runId, w.spawner.run('FAKE-2').runId];
    // FAKE-1's resume hits the limit again, at 09:20; FAKE-2's is refused, leaving its run as it was.
    w.clock.advance(4 * 60_000);
    const limit = {
      seq: 1,
      ts: w.clock().toISOString(),
      runId: run1,
      type: 'run:suspended',
      stopReason: 'usage_limit',
      key: 'spec#1',
      resetsAt: '2026-10-15T10:00:00.000Z',
    };
    writeFileSync(join(w.runs, run1, 'events.ndjson'), `${JSON.stringify(limit)}\n`);
    w.spawner.endResume(run1, { status: 'suspended', stopReason: 'usage_limit' });
    w.spawner.endResume(run2, { log: 'sail resume: LINEAR_API_KEY is not set', code: 3 });
    await dispatcher.tick();
    const held = eventsOf(w.runs, 'queue:held').map(({ until }) => until);
    const parked = w.store.snapshot().items.map((item) => [sourceKey(item), item.state, item.reason]);
    // A resume started by hand while the dispatch was held ends interrupted: past the hold, it is resumed, not parked.
    writeStatus(join(w.runs, run1), 'suspended', 'interrupted');
    w.clock.advance(41 * 60_000);
    await dispatcher.tick();
    expect({
      held,
      parked,
      resumes: w.spawner.resumes.map(({ runId }) => runId),
      resumed: eventsOf(w.runs, 'run:resumed').map(({ dedupKey, from }) => [dedupKey, from]),
    }).toEqual({
      held: ['2026-10-15T09:15:00.000Z', '2026-10-15T10:00:00.000Z'],
      parked: [
        ['FAKE-1', 'dispatched', undefined],
        ['FAKE-2', 'parked', 'its resume failed: sail resume: LINEAR_API_KEY is not set'],
      ],
      resumes: [run1, run2, run1],
      resumed: [
        ['ticket:FAKE-1', { status: 'suspended', stopReason: 'usage_limit' }],
        ['ticket:FAKE-2', { status: 'suspended', stopReason: 'usage_limit' }],
        ['ticket:FAKE-1', { status: 'suspended', stopReason: 'interrupted' }],
      ],
    });
  });
});

test('a resumed run that hits the usage limit again with no event to date it by is held for the back-off from when it was seen again, not from the first limit', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 1, 1);
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    await w.spawner.end('FAKE-1', { status: 'suspended', stopReason: 'usage_limit' });
    await dispatcher.tick();
    const run1 = w.spawner.run('FAKE-1').runId;
    // A resume started by hand while the dispatch was held ends interrupted: past the hold, the dispatcher resumes it.
    writeStatus(join(w.runs, run1), 'suspended', 'interrupted');
    w.clock.advance(16 * 60_000);
    await dispatcher.tick();
    // That resume hits the limit again at 09:20, leaving no event.
    w.clock.advance(4 * 60_000);
    w.spawner.endResume(run1, { status: 'suspended', stopReason: 'usage_limit' });
    await dispatcher.tick();
    expect({
      held: eventsOf(w.runs, 'queue:held').map(({ until }) => until),
      resumes: w.spawner.resumes.map(({ runId }) => runId),
    }).toEqual({
      held: ['2026-10-15T09:15:00.000Z', '2026-10-15T09:35:00.000Z'],
      resumes: [run1],
    });
  });
});

test('a dispatcher started again over the same queue, with the runs still alive, spawns nothing for them and counts them against the cap', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 3, 2);
    await w.dispatcher().tick();
    const reopened = openQueue({ runsDir: w.runs, workflow: 'a', label: 'sail', now: w.clock });
    if ('refused' in reopened) throw new Error(reopened.refused);
    const again = w.dispatcher(reopened);
    for (let tick = 0; tick < 3; tick += 1) await again.tick();
    expect([spawnedKeys(w.spawner), again.inFlight()]).toEqual([['FAKE-1', 'FAKE-2'], 2]);
    await w.spawner.end('FAKE-1');
    await again.tick();
    await again.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-1', 'FAKE-2', 'FAKE-3']);
  });
});

test('an item whose title changed since it was queued waits on a lease of the branch its fresh title names', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 1, 1);
    const state = join(repo.dir, '.sail-runs', 'fake', 'tickets.json');
    const seed = JSON.parse(readFileSync(join(repo.dir, '.sail', 'fake', 'tickets.json'), 'utf8'));
    seed.tickets[0].title = 'Renamed since';
    mkdirSync(join(repo.dir, '.sail-runs', 'fake'), { recursive: true });
    writeFileSync(state, JSON.stringify(seed));
    const { workspace } = w.adapters.ports;
    const { url } = await workspace.repository();
    const fresh = branchFor('sail/', 'FAKE-1', 'Renamed since');
    const holder = { runId: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N', runDir: join(w.runs, 'by-hand'), pid: process.pid };
    expect((await workspace.lease(url, fresh, holder)).leased).toBe(true);
    await w.dispatcher().tick();
    expect([spawnedKeys(w.spawner), states(w.store)]).toEqual([[], ['FAKE-1 queued 0']]);
    expect(eventsOf(w.runs, 'queue:skipped_leased')).toEqual([
      { dedupKey: 'ticket:FAKE-1', branch: fresh, heldBy: holder.runId },
    ]);
  });
});

// Reconcile (DECISIONS D4-D6): what a dispatcher does with a dispatched run it finds alive, dead, stopped, or resumed.

test("a resume whose process ends with its run still suspended parks the item with its log's last line and resumes nothing more, while a new dispatcher over the same queue resumes it once", async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 1, 1);
    const first = w.dispatcher();
    await first.tick();
    await w.spawner.end('FAKE-1', { status: 'suspended', stopReason: 'interrupted' });
    await first.tick();
    const { runId } = w.spawner.run('FAKE-1');
    expect(w.spawner.resumes.map((resume) => resume.runId)).toEqual([runId]);
    const gone = `sail resume: run ${runId}'s workspace can't be reopened: the workspace is gone (invalid)`;
    w.spawner.endResume(runId, { status: 'suspended', stopReason: 'interrupted', log: gone });
    const reopened = openQueue({ runsDir: w.runs, workflow: 'a', label: 'sail', now: w.clock });
    if ('refused' in reopened) throw new Error(reopened.refused);
    const again = w.dispatcher(reopened);
    await again.tick();
    const resumedAgain = w.spawner.resumes.length;
    w.spawner.endResume(runId, { status: 'suspended', stopReason: 'interrupted', log: 'sail resume: it failed again' });
    await again.tick();
    await again.tick();
    expect({
      resumedAgain,
      resumes: w.spawner.resumes.length,
      item: reopened.snapshot().items.map(({ state, attempts, reason }) => ({ state, attempts, reason })),
      parked: eventsOf(w.runs, 'queue:parked'),
      spawned: spawnedKeys(w.spawner),
      issues: queueEventIssues(queueDir(w.runs, 'a')),
    }).toEqual({
      resumedAgain: 2,
      resumes: 2,
      item: [{ state: 'parked', attempts: 1, reason: 'its resume failed: sail resume: it failed again' }],
      parked: [{ dedupKey: 'ticket:FAKE-1', attempts: 1, reason: 'its resume failed: sail resume: it failed again' }],
      spawned: ['FAKE-1'],
      issues: [],
    });
  });
});

test("a resume that dies without logging parks the item with its exit, not with the original run's last line", async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 1, 1);
    await w.dispatcher().tick();
    const { runId, workflow } = w.spawner.run('FAKE-1');
    const log = dispatchLog(w.runs, workflow, runId);
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, "the original run's last line\n");
    await w.spawner.end('FAKE-1', { status: 'suspended', stopReason: 'interrupted' });
    const dispatcher = w.dispatcher(w.store);
    await dispatcher.tick();
    w.spawner.endResume(runId, { status: 'suspended', stopReason: 'interrupted', code: 1 });
    await Bun.sleep(0);
    await dispatcher.tick();
    await dispatcher.tick();
    const reason = 'its resume failed: it exited 1';
    expect({
      item: w.store.snapshot().items.map(({ state, reason }) => ({ state, reason })),
      parked: eventsOf(w.runs, 'queue:parked').map(({ reason }) => reason),
    }).toEqual({ item: [{ state: 'parked', reason }], parked: [reason] });
  });
});

test("a new dispatcher's first tick adopts each live run once with run:adopted, leaves a live run's control file to the run, an unwatched as a stopped one, adopts a dead pid whose lease a live process holds under that pid, and starts nothing over the cap", async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 4, 3);
    await w.dispatcher().tick();
    const [run1, run2, run3] = ['FAKE-1', 'FAKE-2', 'FAKE-3'].map((key) => w.spawner.run(key).runId);
    const dirOf = (runId = '') => join(w.runs, runId);
    for (const runId of [run1, run2]) mkdirSync(dirOf(runId), { recursive: true });
    requestUnwatch(dirOf(run1));
    requestStop(dirOf(run2));
    // FAKE-3's process is gone, and a resume another process started holds its lease.
    await w.spawner.end('FAKE-3', { status: 'running' });
    const { url } = await w.adapters.ports.workspace.repository();
    const branch = branchFor('sail/', 'FAKE-3', 'Ticket FAKE-3');
    writeFileSync(join(dirOf(run3), 'run.json'), `${JSON.stringify({ branch, repository: { url } })}\n`);
    const holder = { runId: run3 ?? '', runDir: dirOf(run3), pid: process.pid };
    expect((await w.adapters.ports.workspace.lease(url, branch, holder)).leased).toBe(true);

    const reopened = openQueue({ runsDir: w.runs, workflow: 'a', label: 'sail', now: w.clock });
    if ('refused' in reopened) throw new Error(reopened.refused);
    const again = w.dispatcher(reopened);
    await again.tick();
    await again.tick();
    const control = (runId = '') =>
      existsSync(join(dirOf(runId), 'CONTROL')) ? readFileSync(join(dirOf(runId), 'CONTROL'), 'utf8') : 'none';
    expect({
      adopted: eventsOf(w.runs, 'run:adopted'),
      control: [control(run1), control(run2)],
      spawned: spawnedKeys(w.spawner),
      resumes: w.spawner.resumes.length,
      inFlight: again.inFlight(),
      pid: reopened.snapshot().items[2]?.pid,
    }).toEqual({
      adopted: [
        { dedupKey: 'ticket:FAKE-1', run: run1, pid: FAKE_PID },
        { dedupKey: 'ticket:FAKE-2', run: run2, pid: FAKE_PID + 1 },
        { dedupKey: 'ticket:FAKE-3', run: run3, pid: process.pid },
      ],
      control: ['unwatched\n', 'stopped\n'],
      spawned: ['FAKE-1', 'FAKE-2', 'FAKE-3'],
      resumes: 0,
      inFlight: 3,
      pid: process.pid,
    });
    await w.spawner.end('FAKE-1');
    await again.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-1', 'FAKE-2', 'FAKE-3', 'FAKE-4']);
    expect(queueEventIssues(queueDir(w.runs, 'a'))).toEqual([]);
  });
});

/** Ends `ticketKey`'s run as `running` with a dead pid, its `run.json` naming the branch and remote its lease is keyed by. */
async function endRunning(w: World, ticketKey: string) {
  await w.spawner.end(ticketKey, { status: 'running' });
  const { url } = await w.adapters.ports.workspace.repository();
  const branch = branchFor('sail/', ticketKey, `Ticket ${ticketKey}`);
  const dir = join(w.runs, w.spawner.run(ticketKey).runId);
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify({ branch, repository: { url } })}\n`);
  return branch;
}

/** A workspace whose `holder` throws `fail()`'s error, when it gives one, for `branch()`'s branch. */
const failingHolder = (branch: () => string | undefined, fail: () => Error | undefined) => (own: WorkspacePort) => ({
  ...own,
  holder: (remote: string, name: string) => {
    const error = name === branch() ? fail() : undefined;
    if (error !== undefined) throw error;
    return own.holder(remote, name);
  },
});

test("a dispatched item whose lease can't be read is left as it was and said once, while the other items settle, the next due item starts, and it settles once its lease reads again", async () => {
  await withTempRepo(async (repo) => {
    let broken: string | undefined;
    let unreadable = true;
    const w = await world(repo, 3, 2, {
      workspace: failingHolder(
        () => broken,
        () => (unreadable ? new PortError('workspace', 'lease', 'invalid', 'lease.json: Unexpected token') : undefined),
      ),
    });
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-1', 'FAKE-2']);
    broken = await endRunning(w, 'FAKE-1');
    await w.spawner.end('FAKE-2');
    await dispatcher.tick();
    await dispatcher.tick();
    expect({
      states: states(w.store),
      spawned: spawnedKeys(w.spawner),
      resumes: w.spawner.resumes.length,
      errors: w.errors,
    }).toEqual({
      states: ['FAKE-1 dispatched 1', 'FAKE-2 done 1', 'FAKE-3 dispatched 1'],
      spawned: ['FAKE-1', 'FAKE-2', 'FAKE-3'],
      resumes: 0,
      errors: ['ticket:FAKE-1 was not settled: workspace.lease: lease.json: Unexpected token (invalid)'],
    });
    unreadable = false;
    await dispatcher.tick();
    expect(w.spawner.resumes.map(({ runId }) => runId)).toEqual([w.spawner.run('FAKE-1').runId]);
    expect(eventsOf(w.runs, 'run:resumed').map((event) => event.dedupKey)).toEqual(['ticket:FAKE-1']);
    expect(states(w.store)).toEqual(['FAKE-1 dispatched 1', 'FAKE-2 done 1', 'FAKE-3 dispatched 1']);
  });
});

test('a lease that reads again and later fails with the same message is said again', async () => {
  await withTempRepo(async (repo) => {
    let broken: string | undefined;
    let unreadable = true;
    const w = await world(repo, 1, 1, {
      workspace: failingHolder(
        () => broken,
        () => (unreadable ? new PortError('workspace', 'lease', 'invalid', 'lease.json: Unexpected token') : undefined),
      ),
    });
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    broken = await endRunning(w, 'FAKE-1');
    await dispatcher.tick();
    unreadable = false;
    await dispatcher.tick();
    const runId = w.spawner.run('FAKE-1').runId;
    expect(w.spawner.resumes.map((each) => each.runId)).toEqual([runId]);
    w.spawner.endResume(runId, { status: 'running' });
    unreadable = true;
    await dispatcher.tick();
    const message = 'ticket:FAKE-1 was not settled: workspace.lease: lease.json: Unexpected token (invalid)';
    expect(w.errors).toEqual([message, message]);
  });
});

test('a new dispatcher whose first settle meets an unreadable lease adopts each live run once across ticks', async () => {
  await withTempRepo(async (repo) => {
    let broken: string | undefined;
    const w = await world(repo, 3, 3, {
      workspace: failingHolder(
        () => broken,
        () => new PortError('workspace', 'lease', 'unavailable', 'lease.json: EACCES'),
      ),
    });
    await w.dispatcher().tick();
    const [run1, run2] = ['FAKE-1', 'FAKE-2'].map((key) => w.spawner.run(key).runId);
    broken = await endRunning(w, 'FAKE-3');
    const reopened = openQueue({ runsDir: w.runs, workflow: 'a', label: 'sail', now: w.clock });
    if ('refused' in reopened) throw new Error(reopened.refused);
    const again = w.dispatcher(reopened);
    for (let tick = 0; tick < 3; tick += 1) await again.tick();
    expect(eventsOf(w.runs, 'run:adopted')).toEqual([
      { dedupKey: 'ticket:FAKE-1', run: run1, pid: FAKE_PID },
      { dedupKey: 'ticket:FAKE-2', run: run2, pid: FAKE_PID + 1 },
    ]);
  });
});

test('a settle that throws something other than a PortError rejects the tick, and the next tick adopts nothing again', async () => {
  await withTempRepo(async (repo) => {
    let broken: string | undefined;
    let thrown = true;
    const w = await world(repo, 2, 2, {
      workspace: failingHolder(
        () => broken,
        () => {
          if (!thrown) return undefined;
          thrown = false;
          return new Error('a bug');
        },
      ),
    });
    await w.dispatcher().tick();
    const run1 = w.spawner.run('FAKE-1').runId;
    broken = await endRunning(w, 'FAKE-2');
    const reopened = openQueue({ runsDir: w.runs, workflow: 'a', label: 'sail', now: w.clock });
    if ('refused' in reopened) throw new Error(reopened.refused);
    const again = w.dispatcher(reopened);
    await expect(again.tick()).rejects.toThrow('a bug');
    await again.tick();
    expect(eventsOf(w.runs, 'run:adopted')).toEqual([{ dedupKey: 'ticket:FAKE-1', run: run1, pid: FAKE_PID }]);
  });
});

test('a stopped run parks its item at once with the run named, and it is never retried', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 1, 1);
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    const { runId } = w.spawner.run('FAKE-1');
    await w.spawner.end('FAKE-1', { status: 'failed', stopReason: 'stopped' });
    await dispatcher.tick();
    w.clock.advance(60 * 60_000);
    await dispatcher.tick();
    expect({
      items: states(w.store),
      reason: w.store.snapshot().items[0]?.reason,
      parked: eventsOf(w.runs, 'queue:parked'),
      spawned: spawnedKeys(w.spawner),
      settled: w.settled.map(({ ticketKey, outcome }) => `${ticketKey} ${outcome}`),
    }).toEqual({
      items: ['FAKE-1 parked 1'],
      reason: `run ${runId} was stopped`,
      parked: [{ dedupKey: 'ticket:FAKE-1', attempts: 1, reason: `run ${runId} was stopped` }],
      spawned: ['FAKE-1'],
      settled: ['FAKE-1 parked'],
    });
  });
});

test('a dead run that never took the unwatched it was sent is resumed with the request taken back, and one sent a stop keeps it (review R1-3)', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 2, 2);
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    const [run1, run2] = ['FAKE-1', 'FAKE-2'].map((key) => w.spawner.run(key).runId);
    const dirOf = (runId = '') => join(w.runs, runId);
    await w.spawner.end('FAKE-1', { status: 'suspended', stopReason: 'interrupted' });
    await w.spawner.end('FAKE-2', { status: 'running' });
    requestUnwatch(dirOf(run1));
    requestStop(dirOf(run2));
    await dispatcher.tick();
    const control = (runId = '') =>
      existsSync(join(dirOf(runId), 'CONTROL')) ? readFileSync(join(dirOf(runId), 'CONTROL'), 'utf8') : 'none';
    expect({
      resumes: w.spawner.resumes.map((resume) => resume.runId),
      control: [control(run1), control(run2)],
    }).toEqual({ resumes: [run1 ?? '', run2 ?? ''], control: ['none', 'stopped\n'] });
  });
});

test('a dispatcher whose cap was lowered resumes dead runs within it: one at a time, the next once the first has ended (review R3-4)', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 2, 2);
    await w.dispatcher().tick();
    const [run1, run2] = ['FAKE-1', 'FAKE-2'].map((key) => w.spawner.run(key).runId);
    await w.spawner.end('FAKE-1', { status: 'suspended', stopReason: 'interrupted' });
    await w.spawner.end('FAKE-2', { status: 'suspended', stopReason: 'interrupted' });
    const reopened = openQueue({ runsDir: w.runs, workflow: 'a', label: 'sail', now: w.clock });
    if ('refused' in reopened) throw new Error(reopened.refused);
    const lowered = createDispatcher({
      workflow: 'a',
      label: 'sail',
      maxConcurrentRuns: 1,
      branchPrefix: 'sail/',
      runsDir: w.runs,
      root: repo.dir,
      store: reopened,
      ticketSource: w.ticketSource,
      codeHost: w.adapters.ports.codeHost,
      workspace: w.adapters.ports.workspace,
      env: repo.env,
      now: w.clock,
      usageLimitBackoffMs: BACKOFF,
      spawn: w.spawner.spawn,
      resume: w.spawner.resume,
      isAlive: w.spawner.isAlive,
    });
    await lowered.tick();
    const first = { resumes: w.spawner.resumes.map((resume) => resume.runId), inFlight: lowered.inFlight() };
    w.spawner.endResume(run1 ?? '');
    await lowered.tick();
    expect({ first, after: w.spawner.resumes.map((resume) => resume.runId) }).toEqual({
      first: { resumes: [run1 ?? ''], inFlight: 1 },
      after: [run1 ?? '', run2 ?? ''],
    });
  });
});

// Forced items (DECISIONS D9): dispatched without the re-check, and started with --force; the lease still holds them.

test('a forced item whose ticket lost its label, or is In Progress, is started with --force, an unforced one is still dropped, and a forced one whose branch is leased still waits', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 4, 4, { claiming: false });
    const state = join(repo.dir, '.sail-runs', 'fake', 'tickets.json');
    const seed = JSON.parse(readFileSync(join(repo.dir, '.sail', 'fake', 'tickets.json'), 'utf8'));
    seed.tickets[0].labels = [];
    seed.tickets[2].labels = [];
    mkdirSync(join(repo.dir, '.sail-runs', 'fake'), { recursive: true });
    writeFileSync(state, JSON.stringify(seed));
    expect((await w.ticketSource.claim('FAKE-2')).claimed).toBe(true);
    const byHand = await leaseByHand(w, 'FAKE-4');
    for (const key of ['FAKE-1', 'FAKE-2', 'FAKE-4']) {
      w.store.drop(`ticket:${key}`, 'to be added again, forced');
      w.store.add([await w.ticketSource.get(key)], { forced: true });
    }
    await w.dispatcher().tick();
    expect({
      started: w.spawner.runs.map((run) => [run.ticketKey, run.force]),
      items: states(w.store),
      dropped: eventsOf(w.runs, 'queue:dropped').filter((event) => event.reason !== 'to be added again, forced'),
      skipped: eventsOf(w.runs, 'queue:skipped_leased'),
    }).toEqual({
      started: [
        ['FAKE-1', true],
        ['FAKE-2', true],
      ],
      items: ['FAKE-1 dispatched 1', 'FAKE-2 dispatched 1', 'FAKE-4 queued 0'],
      dropped: [{ dedupKey: 'ticket:FAKE-3', reason: "it is not designated: it carries no 'sail' label" }],
      skipped: [{ dedupKey: 'ticket:FAKE-4', branch: byHand.branch, heldBy: byHand.holder.runId }],
    });
  });
});

// A ticket the item's own run claimed stays eligible once that run failed: its retry and its requeue start again, forced.

test('a ticket its own run claimed and then failed is retried with --force, not dropped', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 1, 1);
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    await w.spawner.claims();
    await w.spawner.end('FAKE-1', { status: 'failed', stopReason: 'stage_error' });
    await dispatcher.tick();
    w.clock.advance(FIVE_MINUTES);
    await dispatcher.tick();
    await w.spawner.claims();
    expect(w.spawner.runs.map((run) => [run.ticketKey, run.force])).toEqual([
      ['FAKE-1', false],
      ['FAKE-1', true],
    ]);
    expect(eventsOf(w.runs, 'queue:dropped')).toEqual([]);
    expect(states(w.store)).toEqual(['FAKE-1 dispatched 2']);
  });
});

test('a parked item whose run claimed its ticket and was stopped runs again with --force once requeued', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 1, 1);
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    await w.spawner.claims();
    await w.spawner.end('FAKE-1', { status: 'failed', stopReason: 'stopped' });
    await dispatcher.tick();
    expect(states(w.store)).toEqual(['FAKE-1 parked 1']);
    w.store.requeue('ticket:FAKE-1', 'requeued by hand');
    await dispatcher.tick();
    await w.spawner.claims();
    expect(w.spawner.runs.map((run) => [run.ticketKey, run.force])).toEqual([
      ['FAKE-1', false],
      ['FAKE-1', true],
    ]);
    expect(eventsOf(w.runs, 'queue:dropped')).toEqual([]);
  });
});

test('a started ticket not claimed by a failed run of this clone is still dropped', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 3, 3, { claiming: false });
    const ended = (runId: string, status: 'completed' | 'failed') => {
      const dir = join(w.runs, runId);
      mkdirSync(dir, { recursive: true });
      writeStatus(dir, status, status === 'failed' ? 'stage_error' : undefined);
    };
    expect((await w.ticketSource.claim('FAKE-1')).claimed).toBe(true);
    expect((await w.ticketSource.claim('FAKE-2')).claimed).toBe(true);
    await w.ticketSource.comment('FAKE-2', claimComment('FAKE-2-elsewhere'));
    expect((await w.ticketSource.claim('FAKE-3')).claimed).toBe(true);
    await w.ticketSource.comment('FAKE-3', claimComment('FAKE-3-done'));
    ended('FAKE-3-done', 'completed');
    await w.dispatcher().tick();
    expect(spawnedKeys(w.spawner)).toEqual([]);
    expect(eventsOf(w.runs, 'queue:dropped')).toEqual([
      { dedupKey: 'ticket:FAKE-1', reason: 'it is In Progress' },
      { dedupKey: 'ticket:FAKE-2', reason: 'it is In Progress' },
      { dedupKey: 'ticket:FAKE-3', reason: 'it is In Progress' },
    ]);
  });
});

test('a forced item is forced for its first start only: once its run failed, its retry re-checks the ticket and drops it when another run took it to In Review, while a forced first start still starts In Progress', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 2, 2, { claiming: false });
    expect((await w.ticketSource.claim('FAKE-2')).claimed).toBe(true);
    for (const key of ['FAKE-1', 'FAKE-2']) {
      w.store.drop(`ticket:${key}`, 'to be added again, forced');
      w.store.add([await w.ticketSource.get(key)], { forced: true });
    }
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    const firstStarts = w.spawner.runs.map((run) => [run.ticketKey, run.force]);
    await w.spawner.end('FAKE-1', { status: 'failed', stopReason: 'stage_error' });
    await dispatcher.tick();
    // Run by hand meanwhile: it completed, opened its pull request and moved the ticket on.
    await w.ticketSource.update('FAKE-1', { state: 'in-review' });
    w.clock.advance(FIVE_MINUTES);
    await dispatcher.tick();
    expect({
      firstStarts,
      started: spawnedKeys(w.spawner),
      items: states(w.store),
      dropped: eventsOf(w.runs, 'queue:dropped').filter((event) => event.reason !== 'to be added again, forced'),
    }).toEqual({
      firstStarts: [
        ['FAKE-1', true],
        ['FAKE-2', true],
      ],
      started: ['FAKE-1', 'FAKE-2'],
      items: ['FAKE-2 dispatched 1'],
      dropped: [{ dedupKey: 'ticket:FAKE-1', reason: 'it is In Review' }],
    });
  });
});

// Pull requests (14.2's D10): the lease on the queued branch first, from the queue alone, then a re-check of the pull
// request through the CodeHost, and a run pinned to the queued head sha.

const PR_BRANCH = 'sail/FAKE-1-add-a-greeting';

/**
 * The stub with pull request 1 from `PR_BRANCH`, queued in workflow `r`'s queue at its head sha, and a dispatcher of `r`
 * whose CodeHost counts its reads and answers each with `change` over the fake's answer, or throws it.
 */
async function prWorld(repo: TempRepo) {
  const sail = writeStub(repo.dir);
  const headSha = commitBranch(repo, PR_BRANCH);
  seedPullRequests(sail, repo, [{ number: 1, head: PR_BRANCH, title: 'Add a greeting', ticketKey: 'FAKE-1' }]);
  const adapters = await fakeAdapters(repo.dir);
  const runs = join(repo.dir, '.sail-runs');
  const clock = manualClock(START);
  const store = openQueue({ runsDir: runs, workflow: 'r', label: 'sail', now: clock });
  if ('refused' in store) throw new Error(store.refused);
  const own = adapters.ports.codeHost;
  store.addPullRequests(await own.listDesignated('sail'));
  const reads = { count: 0, change: {} as Partial<PullRequestDetails> | Error };
  const codeHost: CodeHost = {
    ...own,
    async getPullRequest(number) {
      reads.count++;
      if (reads.change instanceof Error) throw reads.change;
      return { ...(await own.getPullRequest(number)), ...reads.change };
    },
  };
  const spawner = fakeSpawner(runs);
  const settled: Settled[] = [];
  const dispatcher = createDispatcher({
    workflow: 'r',
    label: 'sail',
    maxConcurrentRuns: 1,
    branchPrefix: 'sail/',
    runsDir: runs,
    root: repo.dir,
    store,
    ticketSource: adapters.ports.ticketSource,
    codeHost,
    workspace: adapters.ports.workspace,
    env: repo.env,
    now: clock,
    usageLimitBackoffMs: BACKOFF,
    spawn: spawner.spawn,
    resume: spawner.resume,
    isAlive: spawner.isAlive,
    onSettled: (each) => settled.push(each),
  });
  const items = () => store.snapshot().items.map((item) => `${sourceKey(item)} ${item.state} ${item.attempts}`);
  const typed = (type: string) =>
    queueEvents(queueDir(runs, 'r'))
      .filter((event) => event.type === type)
      .map(({ seq, ts, workflow, type: _, ...event }) => event);
  return {
    headSha,
    sha7: headSha.slice(0, 7),
    runs,
    store,
    reads,
    spawner,
    settled,
    dispatcher,
    items,
    typed,
    workspace: adapters.ports.workspace,
  };
}

test('a pull-request item whose branch a live run leases waits with one queue:skipped_leased, no attempt and no read of the pull request, then starts as #<n> pinned to its head sha once the lease is released', async () => {
  await withTempRepo(async (repo) => {
    const w = await prWorld(repo);
    const { url } = await w.workspace.repository();
    const ticketRun = { runId: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N', runDir: join(w.runs, 'by-hand'), pid: process.pid };
    await w.workspace.lease(url, PR_BRANCH, ticketRun);
    await w.dispatcher.tick();
    await w.dispatcher.tick();
    const waited = {
      spawned: w.spawner.runs.length,
      reads: w.reads.count,
      items: w.items(),
      skipped: w.typed('queue:skipped_leased'),
    };
    await w.workspace.releaseLease(url, PR_BRANCH, ticketRun.runId);
    await w.dispatcher.tick();
    expect({
      waited,
      runs: w.spawner.runs.map((run) => [run.pr, run.ticketKey, /^pr-1-[0-9A-Z]{26}$/.test(run.runId)]),
      reads: w.reads.count,
      items: w.items(),
    }).toEqual({
      waited: {
        spawned: 0,
        reads: 0,
        items: [`#1@${w.sha7} queued 0`],
        skipped: [{ dedupKey: `pr:1@${w.sha7}`, branch: PR_BRANCH, heldBy: ticketRun.runId }],
      },
      runs: [[{ number: 1, headSha: w.headSha }, undefined, true]],
      reads: 1,
      items: [`#1@${w.sha7} dispatched 1`],
    });
  });
});

test.each<[string, Partial<PullRequestDetails>, (sha7: string) => string]>([
  ['closed', { state: 'closed' }, () => 'it is closed'],
  ['merged', { state: 'merged' }, () => 'it is merged'],
  ['a draft', { draft: true }, () => 'it is a draft'],
  ['unlabelled', { labels: [] }, () => "it is not designated: it carries no 'sail' label"],
  ['a fork', { fork: true }, () => 'it comes from a fork'],
  ['moved to another sha', { headSha: 'b'.repeat(40) }, () => 'its head moved to bbbbbbb: the next poll queues it'],
])('a pull request that is %s by its dispatch is dropped with the reason, and never run', async (_, change, reason) => {
  await withTempRepo(async (repo) => {
    const w = await prWorld(repo);
    w.reads.change = change;
    await w.dispatcher.tick();
    expect({
      dropped: w.typed('queue:dropped'),
      items: w.items(),
      spawned: w.spawner.runs.length,
    }).toEqual({ dropped: [{ dedupKey: `pr:1@${w.sha7}`, reason: reason(w.sha7) }], items: [], spawned: 0 });
  });
});

test('a pull request labelled in another case by its dispatch is dispatched, not dropped', async () => {
  await withTempRepo(async (repo) => {
    const w = await prWorld(repo);
    w.reads.change = { labels: ['SAIL'] };
    await w.dispatcher.tick();
    expect({ dropped: w.typed('queue:dropped'), items: w.items(), spawned: w.spawner.runs.length }).toEqual({
      dropped: [],
      items: [`#1@${w.sha7} dispatched 1`],
      spawned: 1,
    });
  });
});

test('a re-check of a pull request that fails unavailable fails its item with no attempt counted, and starts nothing', async () => {
  await withTempRepo(async (repo) => {
    const w = await prWorld(repo);
    w.reads.change = new PortError('codeHost', 'getPullRequest', 'unavailable', 'the host is down');
    await w.dispatcher.tick();
    const [item] = w.store.snapshot().items;
    expect({
      items: w.items(),
      reason: item?.reason,
      spawned: w.spawner.runs.length,
      settled: w.settled.map((each) => each.pr),
    }).toEqual({
      items: [`#1@${w.sha7} failed 0`],
      reason: 'codeHost.getPullRequest: the host is down (unavailable)',
      spawned: 0,
      settled: [{ number: 1, headSha: w.headSha }],
    });
  });
});

test('under pickUp [Todo], a queued ticket now in Backlog is dropped as Backlog and never spawned', async () => {
  await withTempRepo(async (repo) => {
    const state = join(repo.dir, '.sail-runs', 'fake', 'tickets.json');
    const seedPath = join(repo.dir, '.sail', 'fake', 'tickets.json');
    const w = await world(repo, 2, 2, {
      source: () => createFakeTicketSource({ seed: seedPath, state, pickUp: ['Todo'], now: () => new Date(START) }),
    });
    const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
    seed.tickets[0].state = { type: 'unstarted', name: 'Backlog' };
    mkdirSync(join(repo.dir, '.sail-runs', 'fake'), { recursive: true });
    writeFileSync(state, JSON.stringify(seed));
    await w.dispatcher().tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-2']);
    expect(eventsOf(w.runs, 'queue:dropped')).toEqual([{ dedupKey: 'ticket:FAKE-1', reason: 'it is Backlog' }]);
  });
});

test('with one slot, a ticket whose priority was raised after it was queued is dispatched before the ones queued earlier', async () => {
  await withTempRepo(async (repo) => {
    const w = await world(repo, 3, 1);
    w.store.add([ticket('FAKE-3', { priority: 'urgent' })]);
    const dispatcher = w.dispatcher();
    await dispatcher.tick();
    expect(spawnedKeys(w.spawner)).toEqual(['FAKE-3']);
    expect(states(w.store)).toEqual(['FAKE-3 dispatched 1', 'FAKE-1 queued 0', 'FAKE-2 queued 0']);
  });
});

// A dispatched start is an ordinary `sail <ticket> --workflow <name> --dispatch <run id>` process, so a rerun of a ticket
// whose branch an earlier run pushed continues that branch, as a start by hand does.

const dispatchSource = sharedSource();
afterAll(() => dispatchSource.release());

test('a dispatched rerun of a ticket whose branch is pushed starts from it, and its push is a fast-forward', async () => {
  await withTempRepo(async (repo) => {
    const from = await dispatchSource.copyInto(repo.dir);
    const branch = (
      readEvents(from.dir).find((event) => event.type === 'codehost:pushed') as { branch: string } | undefined
    )?.branch;
    const tip = repo.git('commit-tree', 'main^{tree}', '-p', 'main', '-m', 'work an earlier run pushed');
    repo.git('update-ref', `refs/heads/${branch}`, tip);
    const runId = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3P';
    const runs = join(repo.dir, '.sail-runs');
    const spawned = spawnRun({
      root: repo.dir,
      runsDir: runs,
      workflow: 'ticket-to-pr',
      ticketKey: 'FAKE-1',
      runId,
      env: repo.env,
      force: true,
    });
    const code = await spawned.exited;
    const events = readEvents(join(runs, runId));
    const created = events.find((event) => event.type === 'workspace:created') as { baseSha: string } | undefined;
    const pushed = events.find((event) => event.type === 'codehost:pushed') as { headSha: string } | undefined;
    expect({ code, base: created?.baseSha, pushed: pushed?.headSha }).toEqual({ code: 0, base: tip, pushed: tip });
  });
}, 90_000);
