// One workflow's dispatch (DECISIONS D6-D9): settle the items whose run has ended, then start due items within the
// cap, skipping a leased branch without a slot or an attempt, and dropping an item no longer eligible. On the stub's
// file-backed fakes in a temp repository, a hand-moved clock and a fake spawner.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchFor } from '../../src/engine/branch';
import { requestStop, requestUnwatch } from '../../src/engine/control';
import { PortError } from '../../src/ports/errors';
import type { TicketSource } from '../../src/ports/ticket-source';
import { createDispatcher, type Settled } from '../../src/watch/dispatch';
import { openQueue, type QueueStore, queueDir } from '../../src/watch/queue-store';
import { fakeAdapters } from '../helpers/adapters';
import { manualClock, queueEventIssues, queueEvents } from '../helpers/queue';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';
import { FAKE_PID, type FakeSpawner, fakeSpawner, writeTickets } from '../helpers/watched';

const START = '2026-10-15T09:00:00.000Z';
const FIVE_MINUTES = 5 * 60_000;

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
  options: { claiming?: boolean; source?: (own: TicketSource) => TicketSource } = {},
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
      workspace: adapters.ports.workspace,
      env: repo.env,
      now: clock,
      spawn: spawner.spawn,
      resume: spawner.resume,
      isAlive: spawner.isAlive,
      onSettled: (each) => settled.push(each),
    });
  return { runs, clock, store, ticketSource, adapters, spawner, settled, dispatcher };
}

const spawnedKeys = (spawner: FakeSpawner) => spawner.runs.map((run) => run.ticketKey);
const states = (store: QueueStore) =>
  store.snapshot().items.map((item) => `${item.source.ticketKey} ${item.state} ${item.attempts}`);
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
    expect(w.store.due().map((item) => item.source.ticketKey)).toEqual(['FAKE-2']);
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
      items: w.store.snapshot().items.map((item) => [item.source.ticketKey, item.state, item.attempts, item.pid]),
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

test("a new dispatcher's first tick adopts each live run once with run:adopted, takes back an unwatched its run never reached and keeps a stopped one, adopts a dead pid whose lease a live process holds under that pid, and starts nothing over the cap", async () => {
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
      control: ['none', 'stopped\n'],
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

// Forced items (DECISIONS D9): dispatched without the re-check, and started with --force; the lease still holds them.

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a forced item whose ticket lost its label, or is In Progress, is started with --force, an unforced one is still dropped, and a forced one whose branch is leased still waits', async () => {
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
