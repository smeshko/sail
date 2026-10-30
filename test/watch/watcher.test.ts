// The watcher (DECISIONS D11-D13, D16, D17): the watch set in memory, a poller and a dispatch per workflow, the
// inbox's watch, unwatch and poll commands, its registry field and its stop. On the stub's file-backed fakes in a temp
// repository, fake timers, a temporary registry, and a fake spawner whose runs claim their tickets as they start.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leaseFile } from '../../src/adapters/leases';
import { branchFor } from '../../src/engine/branch';
import { readConfig } from '../../src/engine/config';
import { type Status, type StopReason, writeStatus } from '../../src/engine/run-dir';
import { PortError } from '../../src/ports/errors';
import { commandsDir, dropCommand } from '../../src/watch/inbox';
import { queueDir } from '../../src/watch/queue-store';
import { type RegistryEntry, readEntry, recordEntry } from '../../src/watch/registry';
import { QUEUE_LEASE_DIR, startWatcher, type Watcher, type WatcherOptions } from '../../src/watch/watcher';
import { fakeAdapters } from '../helpers/adapters';
import { fakeTimers } from '../helpers/fake-timers';
import { seedPullRequests, writePrWorkflow } from '../helpers/pr-workflow';
import { queueEventIssues, queueEvents } from '../helpers/queue';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';
import { fakeSpawner, type SeedTicket, writeTickets, writeWatched } from '../helpers/watched';

const START = '2026-10-15T09:00:00.000Z';

/** A repository with the stub's watched copies `workflows` and `tickets`, and a watcher to start over it. */
async function watched(
  repo: TempRepo,
  workflows: { name: string; label: string; cap: number }[],
  tickets: SeedTicket[],
) {
  const sail = writeStub(repo.dir);
  for (const { name, label, cap } of workflows) writeWatched(sail, name, { label, cap });
  writeTickets(sail, tickets);
  const config = readConfig(sail);
  if ('issues' in config) throw new Error('the stub config has issues');
  const adapters = await fakeAdapters(repo.dir);
  const runs = join(repo.dir, '.sail-runs');
  const registryDir = join(repo.home, 'sail-home', 'watchers');
  const entry: RegistryEntry = {
    schema: 'sail.registry.v1',
    name: 'stub',
    remote: null,
    clone: repo.dir,
    sailDir: sail,
    updatedAt: START,
  };
  const timers = fakeTimers(START);
  const spawner = fakeSpawner(runs, adapters.ports.ticketSource);
  const out: string[] = [];
  const start = async (names: string[], overrides: Partial<WatcherOptions> = {}): Promise<Watcher> => {
    const watcher = await startWatcher({
      sailDir: sail,
      config,
      adapters: adapters.ports,
      entry,
      registryDir,
      workflows: names,
      env: repo.env,
      now: timers.now,
      timers,
      spawn: spawner.spawn,
      resume: spawner.resume,
      isAlive: spawner.isAlive,
      write: (text) => out.push(text),
      lines: { timeZone: 'UTC' },
      ...overrides,
    });
    if ('refused' in watcher) throw new Error(watcher.refused);
    return watcher;
  };
  const events = (workflow: string) => queueEvents(queueDir(runs, workflow));
  const order = (workflow: string) =>
    spawner.runs.filter((run) => run.workflow === workflow).map((run) => run.ticketKey);
  return { sail, adapters, runs, registryDir, entry, timers, spawner, out, start, events, order };
}

const tickets = (labels: Record<string, string>): SeedTicket[] =>
  Object.entries(labels).map(([key, label]) => ({ key, labels: [label] }));

/** Whether `watcher` stopped within a second of real time. */
const stopped = (watcher: Watcher) => Promise.race([watcher.done.then(() => true), Bun.sleep(1000).then(() => false)]);

test('a watcher whose start throws after its queue lease drops the pollers it started, clears its registry field and gives back its lease (ADW-212)', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      [],
    );
    const dir = queueDir(w.runs, 'b');
    mkdirSync(dir, { recursive: true });
    const events = join(dir, 'events.ndjson');
    writeFileSync(events, '');
    chmodSync(events, 0o444);
    try {
      expect(await w.start(['a', 'b']).catch(String)).toContain('EACCES');
      expect(readEntry(w.registryDir, 'stub')?.watcher).toBeUndefined();
      expect(w.timers.pending()).toEqual([]);
      expect(w.events('a').at(-1)?.type).toBe('watch:removed');
    } finally {
      chmodSync(events, 0o644);
    }
    const next = await w.start(['a']);
    expect(next.watching()).toEqual(['a']);
    await next.stop();
  });
});

test("a watcher whose workflow can't record watch:removed still stops, giving back its lease and registry field (ADW-212)", async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      [],
    );
    const watcher = await w.start(['a', 'b']);
    const events = join(queueDir(w.runs, 'a'), 'events.ndjson');
    chmodSync(events, 0o444);
    try {
      await watcher.stop();
      expect(await stopped(watcher)).toBe(true);
      expect(w.out.some((line) => line.includes('a') && line.includes('EACCES'))).toBe(true);
      expect(w.events('b').at(-1)?.type).toBe('watch:removed');
      expect(readEntry(w.registryDir, 'stub')?.watcher).toBeUndefined();
      expect(w.timers.pending()).toEqual([]);
    } finally {
      chmodSync(events, 0o644);
    }
    const next = await w.start(['a']);
    expect(next.watching()).toEqual(['a']);
    await next.stop();
  });
});

test('a watcher resolves done even when releasing its queue lease throws (ADW-212)', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], []);
    const watcher = await w.start(['a']);
    const lease = leaseFile(join(w.runs, QUEUE_LEASE_DIR), 'watcher', 'queue');
    chmodSync(lease, 0o000);
    try {
      expect(await watcher.stop().catch(String)).toContain('EACCES');
      expect(await stopped(watcher)).toBe(true);
      expect(w.timers.pending()).toEqual([]);
    } finally {
      chmodSync(lease, 0o600);
    }
  });
});

for (const failure of ['registry', 'lease'] as const) {
  test(`a startup error is preserved when ${failure} cleanup also throws (ADW-212)`, async () => {
    await withTempRepo(async (repo) => {
      const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], []);
      const path =
        failure === 'registry' ? w.registryDir : leaseFile(join(w.runs, QUEUE_LEASE_DIR), 'watcher', 'queue');
      const startupError = new Error('startup output failed');
      try {
        const result = await w
          .start(['a'], {
            write: () => {
              chmodSync(path, failure === 'registry' ? 0o555 : 0o000);
              throw startupError;
            },
          })
          .catch((error: unknown) => error);
        expect(result).toBe(startupError);
        expect(w.timers.pending()).toEqual([]);
        expect(w.events('a').at(-1)?.type).toBe('watch:removed');
      } finally {
        chmodSync(path, failure === 'registry' ? 0o755 : 0o600);
      }
    });
  });
}

test('two workflows at caps 2 and 1 dispatch six tickets once each, in queue order, never over their caps, a leased ticket last and only after its lease is released', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 2 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      tickets({
        'FAKE-1': 'sail-a',
        'FAKE-2': 'sail-a',
        'FAKE-3': 'sail-a',
        'FAKE-4': 'sail-a',
        'FAKE-5': 'sail-b',
        'FAKE-6': 'sail-b',
      }),
    );
    const { workspace, ticketSource } = w.adapters.ports;
    const { url } = await workspace.repository();
    const branch = branchFor('sail/', 'FAKE-3', 'Ticket FAKE-3');
    const byHand = { runId: 'FAKE-3-01M3BWNZM08Q4T6V2XRJ5KWD3N', runDir: join(w.runs, 'by-hand'), pid: process.pid };
    expect((await workspace.lease(url, branch, byHand)).leased).toBe(true);

    const watcher = await w.start(['a', 'b']);
    await w.timers.advance(1000);
    expect([w.order('a'), w.order('b')]).toEqual([['FAKE-1', 'FAKE-2'], ['FAKE-5']]);
    await w.spawner.end('FAKE-1');
    await w.timers.advance(1000);
    await w.timers.advance(3000);
    expect(w.order('a')).toEqual(['FAKE-1', 'FAKE-2', 'FAKE-4']);
    const waiting = JSON.parse(readFileSync(join(queueDir(w.runs, 'a'), 'queue.json'), 'utf8')).items[2];
    expect([waiting.dedupKey, waiting.state, waiting.attempts]).toEqual(['ticket:FAKE-3', 'queued', 0]);
    await w.spawner.end('FAKE-5');
    await w.timers.advance(1000);
    await workspace.releaseLease(url, branch, byHand.runId);
    await w.spawner.end('FAKE-2');
    await w.timers.advance(1000);
    for (const key of ['FAKE-4', 'FAKE-3', 'FAKE-6']) await w.spawner.end(key);
    await w.timers.advance(1000);
    await w.spawner.claims();

    expect({ a: w.order('a'), b: w.order('b'), peak: w.spawner.peak }).toEqual({
      a: ['FAKE-1', 'FAKE-2', 'FAKE-4', 'FAKE-3'],
      b: ['FAKE-5', 'FAKE-6'],
      peak: { a: 2, b: 1 },
    });
    const claimedOnce = [];
    for (const key of ['FAKE-1', 'FAKE-2', 'FAKE-3', 'FAKE-4', 'FAKE-5', 'FAKE-6']) {
      const ticket = await ticketSource.get(key);
      const comments = ticket.comments.filter((comment) => comment.body.startsWith('sail run '));
      claimedOnce.push(`${key} ${ticket.state.name} ${comments.length}`);
    }
    expect(claimedOnce).toEqual([
      'FAKE-1 In Progress 1',
      'FAKE-2 In Progress 1',
      'FAKE-3 In Progress 1',
      'FAKE-4 In Progress 1',
      'FAKE-5 In Progress 1',
      'FAKE-6 In Progress 1',
    ]);
    expect(w.events('a').filter((event) => event.type === 'queue:skipped_leased')).toMatchObject([
      { dedupKey: 'ticket:FAKE-3', branch, heldBy: byHand.runId },
    ]);
    expect([...queueEventIssues(queueDir(w.runs, 'a')), ...queueEventIssues(queueDir(w.runs, 'b'))]).toEqual([]);
    await watcher.stop();
  });
});

test('a config the check refuses pauses the dispatch, said once, until the check passes again, which is said and dispatches', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 2 }], tickets({ 'FAKE-1': 'sail-a' }));
    let problem: string | undefined = 'models.terra: no model x';
    let checks = 0;
    const checkConfig = async () => {
      checks++;
      return problem;
    };
    const watcher = await w.start(['a'], { checkConfig });
    await w.timers.advance(1000);
    await w.timers.advance(1000);
    const paused = { spawned: w.order('a'), said: w.out.filter((line) => line.includes('dispatch paused')).length };
    problem = undefined;
    await w.timers.advance(1000);
    expect({
      paused,
      spawned: w.order('a'),
      lines: w.out.filter((line) => line.includes('dispatch ')).map((line) => line.replace(/^\S+\s+/, '').trim()),
      asked: checks >= 3,
    }).toEqual({
      paused: { spawned: [], said: 1 },
      spawned: ['FAKE-1'],
      lines: [
        'error: dispatch paused until the config is fixed: models.terra: no model x',
        'dispatch resumed: the config can be dispatched on again',
      ],
      asked: true,
    });
    await watcher.stop();
  });
});

test('a watcher started again over the same runs, while they are alive, spawns nothing for them, and the next slot goes to the next ticket', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [{ name: 'a', label: 'sail-a', cap: 2 }],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-a', 'FAKE-3': 'sail-a' }),
    );
    const first = await w.start(['a']);
    await w.timers.advance(1000);
    await first.stop();
    expect(await stopped(first)).toBe(true);
    const again = await w.start(['a']);
    await w.timers.advance(3000);
    expect(w.order('a')).toEqual(['FAKE-1', 'FAKE-2']);
    await w.spawner.end('FAKE-1');
    await w.timers.advance(1000);
    await w.timers.advance(1000);
    expect(w.order('a')).toEqual(['FAKE-1', 'FAKE-2', 'FAKE-3']);
    await again.stop();
  });
});

test("a watch command adds a workflow to the live set, with its watch:added and a watch set line, and leaves the others' runs and queues as they were", async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 2 },
        { name: 'b', label: 'sail-b', cap: 1 },
        { name: 'c', label: 'sail-c', cap: 1 },
      ],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-a', 'FAKE-3': 'sail-b', 'FAKE-4': 'sail-c' }),
    );
    const watcher = await w.start(['a', 'b']);
    await w.timers.advance(1000);
    expect([w.order('a'), w.order('b')]).toEqual([['FAKE-1', 'FAKE-2'], ['FAKE-3']]);
    const queues = () => ['a', 'b'].map((name) => readFileSync(join(queueDir(w.runs, name), 'queue.json'), 'utf8'));
    const before = queues();
    dropCommand(w.runs, { op: 'watch', workflows: ['a', 'c'] });
    await w.timers.advance(1000);
    expect(watcher.watching()).toEqual(['a', 'b', 'c']);
    expect(w.out).toContain('09:00:02 watch set: a, b, c\n');
    expect(w.events('c').filter((event) => event.type === 'watch:added')).toMatchObject([
      { pid: process.pid, label: 'sail-c', everyMs: 30_000, maxConcurrentRuns: 1 },
    ]);
    expect([w.order('a'), w.order('b'), w.order('c')]).toEqual([['FAKE-1', 'FAKE-2'], ['FAKE-3'], ['FAKE-4']]);
    expect(queues()).toEqual(before);
    expect(readdirSync(commandsDir(w.runs))).toEqual([]);
    expect(queueEventIssues(queueDir(w.runs, 'c'))).toEqual([]);
    await watcher.stop();
  });
});

test("a watch command for a workflow on a watched workflow's label is rejected with its reason, and the set stays as it was", async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'd', label: 'sail-a', cap: 1 },
      ],
      tickets({ 'FAKE-1': 'sail-a' }),
    );
    const watcher = await w.start(['a']);
    dropCommand(w.runs, { op: 'watch', workflows: ['d'] });
    await w.timers.advance(1000);
    expect(watcher.watching()).toEqual(['a']);
    expect(w.out.filter((line) => line.includes('error'))).toEqual([
      expect.stringMatching(/^09:00:01 error: .+\.json failed: workflows 'a' and 'd' both poll the label 'sail-a'\n$/),
    ]);
    expect(w.events('d').filter((event) => event.type === 'watch:added')).toEqual([]);
    await watcher.stop();
  });
});

test('a watcher on a scoped ticket source records its name and scope in the registry', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], tickets({ 'FAKE-1': 'sail-a' }));
    const ticketSource = new Proxy(w.adapters.ports.ticketSource, {
      get: (target, property) => (property === 'scope' ? 'ADW' : Reflect.get(target, property)),
    });
    const watcher = await w.start(['a'], { adapters: { ...w.adapters.ports, ticketSource } });
    try {
      expect(readEntry(w.registryDir, 'stub')?.watcher?.ticketSource).toBe('fake:ADW');
    } finally {
      await watcher.stop();
    }
  });
});

test('unwatching every workflow stops the watcher: each stream ends with its watch:removed, and the registry entry loses its watcher', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-b' }),
    );
    const watcher = await w.start(['a', 'b']);
    expect(readEntry(w.registryDir, 'stub')?.watcher).toMatchObject({
      pid: process.pid,
      sailDir: w.sail,
      ticketSource: 'fake',
      labels: ['sail-a', 'sail-b'],
    });
    await w.timers.advance(1000);
    dropCommand(w.runs, { op: 'unwatch', workflows: ['a', 'b', 'c'] });
    await w.timers.advance(1000);
    expect(await stopped(watcher)).toBe(true);
    expect(['a', 'b'].map((name) => w.events(name).at(-1))).toMatchObject([
      { type: 'watch:removed', pid: process.pid },
      { type: 'watch:removed', pid: process.pid },
    ]);
    expect(readEntry(w.registryDir, 'stub')).toEqual(w.entry);
    expect(w.out.at(-1)).toBe('09:00:02 watch set: empty; the watcher stops\n');
    expect(w.timers.pending()).toEqual([]);
  });
});

test('a command left in the inbox before the watcher starts is deleted unapplied', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], tickets({ 'FAKE-1': 'sail-a' }));
    dropCommand(w.runs, { op: 'unwatch', workflows: ['a'] });
    const watcher = await w.start(['a']);
    expect(existsSync(commandsDir(w.runs)) ? readdirSync(commandsDir(w.runs)) : []).toEqual([]);
    await w.timers.advance(2000);
    expect(watcher.watching()).toEqual(['a']);
    expect(w.order('a')).toEqual(['FAKE-1']);
    await watcher.stop();
  });
});

test('an unwatch of the whole set followed in the same drain by a watch keeps the watcher running on the new set, ticking and dispatching (review R1-3)', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      tickets({ 'FAKE-1': 'sail-b' }),
    );
    const watcher = await w.start(['a']);
    dropCommand(w.runs, { op: 'unwatch', workflows: ['a'] });
    dropCommand(w.runs, { op: 'watch', workflows: ['b'] });
    await w.timers.advance(1000);
    await w.timers.advance(1000);
    expect({
      stopped: await Promise.race([watcher.done.then(() => true), Bun.sleep(50).then(() => false)]),
      watching: watcher.watching(),
      labels: readEntry(w.registryDir, 'stub')?.watcher?.labels,
      b: w.order('b'),
      lines: w.out.filter((line) => line.includes('watch set')),
    }).toEqual({
      stopped: false,
      watching: ['b'],
      labels: ['sail-b'],
      b: ['FAKE-1'],
      lines: ['09:00:00 watch set: a\n', '09:00:01 watch set: b\n'],
    });
    await watcher.stop();
    expect(await stopped(watcher)).toBe(true);
    expect(readEntry(w.registryDir, 'stub')).toEqual(w.entry);
  });
});

test('a poll still in flight when its workflow is unwatched never writes over the queue of the workflow watched again, which keeps its dispatch, and the stream keeps its order (review R1-2)', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      [],
    );
    const real = w.adapters.ports.ticketSource;
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The provider answers a's second poll at once, and the answer arrives only once the gate opens.
    const slow: typeof real = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      async listDesignated(label: string) {
        const answer = await real.listDesignated(label);
        if (label === 'sail-a' && ++calls === 2) await gate;
        return answer;
      },
    });
    (w.adapters.ports as { ticketSource: typeof real }).ticketSource = slow;
    const watcher = await w.start(['a', 'b']);
    writeTickets(w.sail, tickets({ 'FAKE-1': 'sail-a' }));
    dropCommand(w.runs, { op: 'poll', workflow: 'a' });
    dropCommand(w.runs, { op: 'unwatch', workflows: ['a'] });
    dropCommand(w.runs, { op: 'watch', workflows: ['a'] });
    setTimeout(release, 100);
    await w.timers.advance(1000);
    await Bun.sleep(200);
    await w.spawner.claims();
    const items = JSON.parse(readFileSync(join(queueDir(w.runs, 'a'), 'queue.json'), 'utf8')).items;
    const seqs = w.events('a').map((event) => event.seq as number);
    expect({
      items: items.map((item: Record<string, unknown>) => [item.dedupKey, item.state, item.pid]),
      runs: w.order('a'),
      seqs: seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] as number)),
      issues: queueEventIssues(queueDir(w.runs, 'a')),
    }).toEqual({
      items: [['ticket:FAKE-1', 'dispatched', w.spawner.run('FAKE-1').pid]],
      runs: ['FAKE-1'],
      seqs: true,
      issues: [],
    });
    await watcher.stop();
  });
});

test('a watcher whose registry field another live watcher wrote over stops at its next tick, and one whose field a registration dropped writes it back (review R1-1)', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], []);
    const watcher = await w.start(['a']);
    const mine = readEntry(w.registryDir, 'stub')?.watcher;
    if (mine === undefined) throw new Error('the watcher recorded no field');
    recordEntry(w.registryDir, { ...w.entry, updatedAt: '2026-10-15T09:00:00.500Z' });
    await w.timers.advance(1000);
    expect(readEntry(w.registryDir, 'stub')).toEqual({
      ...w.entry,
      updatedAt: '2026-10-15T09:00:00.500Z',
      watcher: mine,
    });
    // A second watcher of the repository that started at the same instant, and whose write landed last.
    const other = { ...mine, pid: process.ppid };
    recordEntry(w.registryDir, { ...w.entry, watcher: other });
    await w.timers.advance(1000);
    expect(await stopped(watcher)).toBe(true);
    expect(w.out.slice(-2)).toEqual([
      `09:00:02 error: another watcher of 'stub' runs here (pid ${process.ppid}), recorded after this one: this one stops\n`,
      '09:00:02 a  unwatched\n',
    ]);
    expect(readEntry(w.registryDir, 'stub')?.watcher).toEqual(other);
    expect(w.events('a').at(-1)).toMatchObject({ type: 'watch:removed', pid: process.pid });
  });
});

test('a poll that never answers holds up neither an unwatch of its workflow, the other workflows, nor the stop, and its late answer writes nothing (review R2-3)', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      [],
    );
    const real = w.adapters.ports.ticketSource;
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hanging: typeof real = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      async listDesignated(label: string) {
        const answer = await real.listDesignated(label);
        if (label === 'sail-a' && ++calls === 2) await gate;
        return answer;
      },
    });
    (w.adapters.ports as { ticketSource: typeof real }).ticketSource = hanging;
    const watcher = await w.start(['a', 'b']);
    writeTickets(w.sail, tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-b' }));
    dropCommand(w.runs, { op: 'poll', workflow: 'a' });
    dropCommand(w.runs, { op: 'unwatch', workflows: ['a'] });
    dropCommand(w.runs, { op: 'poll', workflow: 'b' });
    const within = (done: Promise<unknown>) =>
      Promise.race([done.then(() => 'done'), Bun.sleep(2000).then(() => 'blocked')]);
    const ticked = await within(w.timers.advance(1000));
    const ticked2 = await within(w.timers.advance(1000));
    const a = () => readFileSync(join(queueDir(w.runs, 'a'), 'queue.json'), 'utf8');
    const before = { queue: a(), events: w.events('a').length };
    const stopping = await within(watcher.stop());
    release();
    await Bun.sleep(50);
    expect({
      ticked,
      ticked2,
      stopping,
      watching: watcher.watching(),
      b: w.order('b'),
      a: { queue: a(), events: w.events('a').length },
      last: w.events('a').at(-1)?.type,
    }).toEqual({
      ticked: 'done',
      ticked2: 'done',
      stopping: 'done',
      watching: [],
      b: ['FAKE-2'],
      a: before,
      last: 'watch:removed',
    });
  });
});

test("a second watcher over the same .sail/ is refused while the first runs, even when it can't see the first in the registry, and starts once the first stops (review R2-1)", async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], tickets({ 'FAKE-1': 'sail-a' }));
    const first = await w.start(['a']);
    const queue = () => readFileSync(join(queueDir(w.runs, 'a'), 'queue.json'), 'utf8');
    const before = queue();
    const config = readConfig(w.sail);
    if ('issues' in config) throw new Error('the stub config has issues');
    // Started at the same instant: its registry read came before the first watcher's write, as a registry of its own
    // stands in for here, so only the queue's lease is left to keep the two apart.
    const options: WatcherOptions = {
      sailDir: w.sail,
      config,
      adapters: w.adapters.ports,
      entry: w.entry,
      registryDir: join(repo.home, 'other-sail-home', 'watchers'),
      workflows: ['a'],
      env: repo.env,
      now: w.timers.now,
      timers: w.timers,
      spawn: w.spawner.spawn,
      resume: w.spawner.resume,
      isAlive: w.spawner.isAlive,
      write: (text) => w.out.push(text),
      lines: { timeZone: 'UTC' },
      pid: process.ppid,
    };
    const second = await startWatcher(options);
    expect(second).toEqual({
      refused: `a watcher for 'stub' already runs here (pid ${process.pid}, since 2026-10-15T09:00:00.000Z)`,
    });
    expect(queue()).toBe(before);
    expect(w.events('a').filter((event) => event.type === 'watch:added')).toHaveLength(1);
    await first.stop();
    const third = await startWatcher(options);
    expect('refused' in third ? third : third.watching()).toEqual(['a']);
    if (!('refused' in third)) await third.stop();
  });
});

test("a watcher whose field a registration left stale stops, naming the holder, when another repository's watcher took one of its labels meanwhile (review R2-2)", async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      [],
    );
    const watcher = await w.start(['a', 'b']);
    const mine = readEntry(w.registryDir, 'stub')?.watcher;
    if (mine === undefined) throw new Error('the watcher recorded no field');
    recordEntry(w.registryDir, { ...w.entry, watcher: { ...mine, labels: ['sail-a'] } });
    const other = {
      schema: 'sail.registry.v1' as const,
      name: 'other',
      remote: null,
      clone: join(repo.home, 'other'),
      sailDir: join(repo.home, 'other', '.sail'),
      updatedAt: START,
      watcher: { ...mine, pid: process.ppid, sailDir: join(repo.home, 'other', '.sail'), labels: ['sail-b'] },
    };
    recordEntry(w.registryDir, other);
    await w.timers.advance(1000);
    expect(await stopped(watcher)).toBe(true);
    expect(w.out.filter((line) => line.includes('error'))).toEqual([
      `09:00:01 error: the label 'sail-b' on the fake ticket source is polled by the watcher of 'other' in ${join(repo.home, 'other')} (pid ${process.ppid}): this watcher stops\n`,
    ]);
    expect(readEntry(w.registryDir, 'other')).toEqual(other);
  });
});

test("a watch command whose workflow's first poll never answers holds up neither the tick, the other workflows nor the stop (review R3-1)", async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      tickets({ 'FAKE-1': 'sail-a' }),
    );
    const real = w.adapters.ports.ticketSource;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hanging: typeof real = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      async listDesignated(label: string) {
        const answer = await real.listDesignated(label);
        if (label === 'sail-b') await gate;
        return answer;
      },
    });
    const config = readConfig(w.sail);
    if ('issues' in config) throw new Error('the stub config has issues');
    const watcher = await startWatcher({
      sailDir: w.sail,
      config,
      adapters: { ...w.adapters.ports, ticketSource: hanging },
      entry: w.entry,
      registryDir: w.registryDir,
      workflows: ['a'],
      env: repo.env,
      now: w.timers.now,
      timers: w.timers,
      spawn: w.spawner.spawn,
      resume: w.spawner.resume,
      isAlive: w.spawner.isAlive,
      write: (text) => w.out.push(text),
      lines: { timeZone: 'UTC' },
      firstPollMs: 50,
    });
    if ('refused' in watcher) throw new Error(watcher.refused);
    dropCommand(w.runs, { op: 'watch', workflows: ['b'] });
    const within = (done: Promise<unknown>) =>
      Promise.race([done.then(() => 'done'), Bun.sleep(2000).then(() => 'blocked')]);
    const ticked = await within(w.timers.advance(1000));
    const watching = watcher.watching();
    const stopping = await within(watcher.stop());
    release();
    expect({ ticked, watching, a: w.order('a'), stopping }).toEqual({
      ticked: 'done',
      watching: ['a', 'b'],
      a: ['FAKE-1'],
      stopping: 'done',
    });
  });
});

// 13.3 (DECISIONS D2, D10, D11): an unwatch asks the workflow's runs to suspend, the watcher's own stop asks nothing,
// and a starting watcher sweeps the worktrees of ended runs.

test("unwatching b asks each live run of b, and none of a's, to suspend through its control file, keeps b's queue.json byte for byte and says so per run, and the watcher's own stop asks nothing", async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 2 },
      ],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-b', 'FAKE-3': 'sail-b', 'FAKE-4': 'sail-b' }),
    );
    const watcher = await w.start(['a', 'b']);
    await w.timers.advance(1000);
    expect([w.order('a'), w.order('b')]).toEqual([['FAKE-1'], ['FAKE-2', 'FAKE-3']]);
    const [run1, run2, run3] = ['FAKE-1', 'FAKE-2', 'FAKE-3'].map((key) => join(w.runs, w.spawner.run(key).runId));
    for (const dir of [run1, run2, run3]) mkdirSync(dir ?? '', { recursive: true });
    const queueOfB = () => readFileSync(join(queueDir(w.runs, 'b'), 'queue.json'), 'utf8');
    const before = queueOfB();
    dropCommand(w.runs, { op: 'unwatch', workflows: ['b'] });
    await w.timers.advance(1000);
    const control = (dir = '') =>
      existsSync(join(dir, 'CONTROL')) ? readFileSync(join(dir, 'CONTROL'), 'utf8') : 'none';
    const afterUnwatch = [control(run1), control(run2), control(run3)];
    await watcher.stop();
    expect({
      afterUnwatch,
      afterStop: control(run1),
      queue: queueOfB() === before,
      lines: w.out.filter((line) => line.includes('suspends')),
      watching: watcher.watching(),
    }).toEqual({
      afterUnwatch: ['none', 'unwatched\n', 'unwatched\n'],
      afterStop: 'none',
      queue: true,
      lines: [
        `09:00:02 b  FAKE-2 suspends at its next call boundary: run ${w.spawner.run('FAKE-2').runId}\n`,
        `09:00:02 b  FAKE-3 suspends at its next call boundary: run ${w.spawner.run('FAKE-3').runId}\n`,
      ],
      watching: [],
    });
  });
});

test('unwatching b while a run of b is still starting, with no run directory yet, writes unwatched to its hand-off file and says it suspends, as it does for the run that has a directory', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 2 },
      ],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-b', 'FAKE-3': 'sail-b' }),
    );
    const watcher = await w.start(['a', 'b']);
    await w.timers.advance(1000);
    expect(w.order('b')).toEqual(['FAKE-2', 'FAKE-3']);
    const [started, starting] = ['FAKE-2', 'FAKE-3'].map((key) => w.spawner.run(key).runId);
    mkdirSync(join(w.runs, started ?? ''), { recursive: true });
    dropCommand(w.runs, { op: 'unwatch', workflows: ['b'] });
    await w.timers.advance(1000);
    await watcher.stop();
    expect({
      control: readFileSync(join(w.runs, started ?? '', 'CONTROL'), 'utf8'),
      handOff: readFileSync(join(w.runs, `${starting}.control`), 'utf8'),
      lines: w.out.filter((line) => line.includes('suspend')),
    }).toEqual({
      control: 'unwatched\n',
      handOff: 'unwatched\n',
      lines: [
        `09:00:02 b  FAKE-2 suspends at its next call boundary: run ${started}\n`,
        `09:00:02 b  FAKE-3 suspends at its next call boundary: run ${starting}\n`,
      ],
    });
  });
});

test('unwatching b asks a run of b that a resume by hand keeps alive, its dispatched pid gone, to suspend (review R3-2)', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-b' }),
    );
    const watcher = await w.start(['a', 'b']);
    await w.timers.advance(1000);
    const { runId } = w.spawner.run('FAKE-2');
    const dir = join(w.runs, runId);
    await w.spawner.end('FAKE-2', { status: 'running' });
    // `sail resume` by hand: this process holds the run's lease.
    const { workspace } = w.adapters.ports;
    const { url } = await workspace.repository();
    const branch = branchFor('sail/', 'FAKE-2', 'Ticket FAKE-2');
    writeFileSync(join(dir, 'run.json'), `${JSON.stringify({ branch, repository: { url } })}\n`);
    expect((await workspace.lease(url, branch, { runId, runDir: dir, pid: process.pid })).leased).toBe(true);
    dropCommand(w.runs, { op: 'unwatch', workflows: ['b'] });
    await w.timers.advance(1000);
    await watcher.stop();
    expect(existsSync(join(dir, 'CONTROL')) ? readFileSync(join(dir, 'CONTROL'), 'utf8') : 'none').toBe('unwatched\n');
  });
});

test('a watcher starting over completed, failed, running, suspended interrupted and suspended unwatched runs, each with a worktree, sweeps the first two worktrees, keeps the other three and says so', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], []);
    const { workspace } = w.adapters.ports;
    const ends: [Status, StopReason?][] = [
      ['completed'],
      ['failed', 'stage_error'],
      ['running'],
      ['suspended', 'interrupted'],
      ['suspended', 'unwatched'],
    ];
    const worktrees: string[] = [];
    for (const [index, [status, stopReason]] of ends.entries()) {
      const runId = `FAKE-${index + 1}-01M3BWNZM08Q4T6V2XRJ5KWD3N`;
      const runDir = join(w.runs, runId);
      mkdirSync(runDir, { recursive: true });
      const made = await workspace.create({ runId, runDir }, { branch: `sail/FAKE-${index + 1}` });
      worktrees.push(made.path);
      writeStatus(runDir, status, stopReason);
    }
    const watcher = await w.start(['a']);
    expect({
      kept: worktrees.map((path) => existsSync(path)),
      lines: w.out.filter((line) => line.includes('swept')),
    }).toEqual({
      kept: [false, false, true, true, true],
      lines: ['09:00:00 swept 2 worktrees of ended runs\n'],
    });
    await watcher.stop();
  });
});

test.skipIf(process.getuid?.() === 0)(
  'a watcher reports a partial sweep after its swept count and still dispatches',
  async () => {
    await withTempRepo(async (repo) => {
      const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], tickets({ 'FAKE-1': 'sail-a' }));
      const { workspace } = w.adapters.ports;
      const worktrees: string[] = [];
      for (const runId of ['ended-1', 'ended-2']) {
        const runDir = join(w.runs, runId);
        mkdirSync(runDir, { recursive: true });
        worktrees.push((await workspace.create({ runId, runDir }, { branch: `sail/${runId}` })).path);
        writeStatus(runDir, 'completed');
      }
      const readOnly = join(w.runs, 'ended-2');
      chmodSync(readOnly, 0o555);
      try {
        const watcher = await w.start(['a']);
        try {
          const lines = w.out.filter((line) => line.includes('swept') || line.includes('not removed'));
          expect(lines).toHaveLength(2);
          expect(lines[0]).toBe('09:00:00 swept 1 worktree of ended runs\n');
          expect(lines[1]).toStartWith(
            `09:00:00 error: the workspace ${worktrees[1]} of an ended run was not removed: `,
          );
          expect(lines[1]).toContain('EACCES');
          expect(worktrees.map((path) => existsSync(path))).toEqual([false, true]);
          await w.timers.advance(1000);
          expect(w.order('a')).toEqual(['FAKE-1']);
        } finally {
          await watcher.stop();
        }
      } finally {
        chmodSync(readOnly, 0o755);
      }
    });
  },
);

test('a watcher distinguishes a removed workspace whose commits were not kept', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], tickets({}));
    const path = join(w.runs, 'gone/workspace');
    const workspace = new Proxy(w.adapters.ports.workspace, {
      get: (target, property) =>
        property === 'sweep'
          ? async () => ({ paths: [], failed: [{ path, reason: 'its commits were not kept' }], raw: null })
          : Reflect.get(target, property),
    });
    const watcher = await w.start(['a'], { adapters: { ...w.adapters.ports, workspace } });
    try {
      expect(w.out.find((line) => line.includes(path))).toBe(
        `09:00:00 error: the workspace ${path} of an ended run was removed, but its release failed: its commits were not kept\n`,
      );
    } finally {
      await watcher.stop();
    }
  });
});

test('a watcher reports every sweep failure with its exact reason even when no workspace was swept', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], tickets({ 'FAKE-1': 'sail-a' }));
    const paths = ['a', 'b'].map((name) => join(w.runs, name, 'workspace'));
    for (const path of paths) mkdirSync(path, { recursive: true });
    const workspace = new Proxy(w.adapters.ports.workspace, {
      get: (target, property) =>
        property === 'sweep'
          ? async () => ({
              paths: [],
              failed: [
                { path: paths[0] as string, reason: 'permission denied' },
                { path: paths[1] as string, reason: 'its commits were not kept' },
              ],
              raw: null,
            })
          : Reflect.get(target, property),
    });
    const watcher = await w.start(['a'], { adapters: { ...w.adapters.ports, workspace } });
    try {
      expect(w.out.filter((line) => line.includes('swept') || line.includes('not removed'))).toEqual([
        `09:00:00 error: the workspace ${paths[0]} of an ended run was not removed: permission denied\n`,
        `09:00:00 error: the workspace ${paths[1]} of an ended run was not removed: its commits were not kept\n`,
      ]);
      await w.timers.advance(1000);
      expect(w.order('a')).toEqual(['FAKE-1']);
    } finally {
      await watcher.stop();
    }
  });
});

// Error isolation: one failure never stops the watcher or starves its other workflows.

test("a watcher whose sweep of ended runs' worktrees fails still starts, says so, and dispatches", async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], tickets({ 'FAKE-1': 'sail-a' }));
    const workspace = new Proxy(w.adapters.ports.workspace, {
      get: (target, property) =>
        property === 'sweep' ? () => Promise.reject(new Error('sweep failed')) : Reflect.get(target, property),
    });
    const watcher = await w.start(['a'], { adapters: { ...w.adapters.ports, workspace } });
    expect({ lines: w.out.filter((line) => line.includes('swept')), watching: watcher.watching() }).toEqual({
      lines: ['09:00:00 error: the worktrees of ended runs were not swept: sweep failed\n'],
      watching: ['a'],
    });
    await w.timers.advance(1000);
    expect(w.order('a')).toEqual(['FAKE-1']);
    await watcher.stop();
  });
});

test('one workflow whose dispatch throws prints its error and the next workflow still dispatches in the same tick', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-b' }),
    );
    const ticketSource = new Proxy(w.adapters.ports.ticketSource, {
      get: (target, property) =>
        property === 'get'
          ? async (key: string) => {
              if (key === 'FAKE-1') throw new Error('get failed');
              return target.get(key);
            }
          : Reflect.get(target, property),
    });
    const watcher = await w.start(['a', 'b'], { adapters: { ...w.adapters.ports, ticketSource } });
    await w.timers.advance(1000);
    expect({
      errors: w.out.filter((line) => line.includes(' error: ')),
      a: w.order('a'),
      b: w.order('b'),
    }).toEqual({ errors: ['09:00:01 a  error: get failed\n'], a: [], b: ['FAKE-2'] });
    await watcher.stop();
  });
});

test("a dispatched run whose lease can't be read prints one error line across ticks, and the workflow still dispatches its next ticket", async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [{ name: 'a', label: 'sail-a', cap: 2 }],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-a', 'FAKE-3': 'sail-a' }),
    );
    let broken: string | undefined;
    const workspace = new Proxy(w.adapters.ports.workspace, {
      get: (target, property) =>
        property === 'holder'
          ? async (remote: string, branch: string) => {
              if (branch === broken)
                throw new PortError('workspace', 'lease', 'invalid', 'lease.json: Unexpected token');
              return target.holder(remote, branch);
            }
          : Reflect.get(target, property),
    });
    const watcher = await w.start(['a'], { adapters: { ...w.adapters.ports, workspace } });
    await w.timers.advance(1000);
    expect(w.order('a')).toEqual(['FAKE-1', 'FAKE-2']);
    await w.spawner.end('FAKE-1', { status: 'running' });
    broken = branchFor('sail/', 'FAKE-1', 'Ticket FAKE-1');
    const { url } = await w.adapters.ports.workspace.repository();
    const header = JSON.stringify({ branch: broken, repository: { url } });
    writeFileSync(join(w.runs, w.spawner.run('FAKE-1').runId, 'run.json'), `${header}\n`);
    await w.spawner.end('FAKE-2');
    for (let tick = 0; tick < 4; tick += 1) await w.timers.advance(1000);
    expect({
      errors: w.out.filter((line) => line.includes(' error: ')),
      a: w.order('a'),
    }).toEqual({
      errors: [
        expect.stringMatching(
          /^09:00:\d\d a {2}error: ticket:FAKE-1 was not settled: workspace\.lease: lease\.json: Unexpected token \(invalid\)\n$/,
        ),
      ],
      a: ['FAKE-1', 'FAKE-2', 'FAKE-3'],
    });
    await watcher.stop();
  });
});

test("a watcher whose queue lease can't be taken is refused naming its lease directory, and opens no queue", async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], []);
    mkdirSync(w.runs, { recursive: true });
    writeFileSync(join(w.runs, '.watcher'), '');
    const lease = join(w.runs, '.watcher');
    const message = await w.start(['a']).catch((error: unknown) => String(error));
    expect(message).toContain(`the watcher's lease in ${lease} can't be taken: `);
    expect({ queue: existsSync(queueDir(w.runs, 'a')), watcher: readEntry(w.registryDir, 'stub')?.watcher }).toEqual({
      queue: false,
      watcher: undefined,
    });
  });
});

test('a command drained after the watcher began stopping is rejected as the watcher is stopping, and adds no workflow', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      [],
    );
    let armed = false;
    let watcher: Watcher | undefined;
    const timers = {
      set: w.timers.set,
      pending: w.timers.pending,
      advance: w.timers.advance,
      now: w.timers.now,
      clear: (handle: Parameters<typeof w.timers.clear>[0]) => {
        if (armed && watcher !== undefined) {
          armed = false;
          void watcher.stop();
        }
        w.timers.clear(handle);
      },
    };
    watcher = await w.start(['a'], { timers });
    armed = true;
    dropCommand(w.runs, { op: 'poll', workflow: 'a' });
    dropCommand(w.runs, { op: 'watch', workflows: ['b'] });
    await w.timers.advance(1000);
    expect({
      rejected: rejections(w.out),
      watching: watcher.watching(),
      stopped: await stopped(watcher),
      added: w.events('b').filter((event) => event.type === 'watch:added'),
    }).toEqual({ rejected: ['the watcher is stopping\n'], watching: [], stopped: true, added: [] });
  });
});

// Queue commands by hand (DECISIONS D8, D9): add, requeue and drop, each safe to apply twice, for a watched workflow.

/** The reasons the watcher printed for the commands it rejected, in order. */
const rejections = (out: string[]) =>
  out.filter((line) => line.includes(' error: ')).map((line) => line.replace(/^.* error: [^ ]+\.json failed: /, ''));

test('an add command queues a designated, unstarted ticket once, even applied twice; an undesignated or a started one is rejected with its reason and queues nothing, unless forced, which queues it forced', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], []);
    const watcher = await w.start(['a']);
    writeTickets(w.sail, [
      { key: 'FAKE-1', labels: ['sail-a'] },
      { key: 'FAKE-2', labels: [] },
      { key: 'FAKE-3', labels: ['sail-a'], state: { type: 'started', name: 'In Progress' } },
      { key: 'FAKE-4', labels: [] },
    ]);
    for (const ticketKey of ['FAKE-1', 'FAKE-1', 'FAKE-2', 'FAKE-3']) {
      dropCommand(w.runs, { op: 'add', workflow: 'a', ticketKey });
    }
    dropCommand(w.runs, { op: 'add', workflow: 'a', ticketKey: 'FAKE-4', force: true });
    await w.timers.advance(1000);
    const items = JSON.parse(readFileSync(join(queueDir(w.runs, 'a'), 'queue.json'), 'utf8')).items;
    expect({
      added: w
        .events('a')
        .filter((event) => event.type === 'queue:item_added')
        .map((event) => event.dedupKey),
      items: items.map((item: Record<string, unknown>) => [item.dedupKey, item.forced]),
      rejected: rejections(w.out),
    }).toEqual({
      added: ['ticket:FAKE-1', 'ticket:FAKE-4'],
      items: [
        ['ticket:FAKE-1', undefined],
        ['ticket:FAKE-4', true],
      ],
      rejected: [
        "the ticket is not designated: it carries no 'sail-a' label. --force runs it anyway\n",
        'the ticket is already claimed: it is In Progress. --force runs it anyway\n',
      ],
    });
    await watcher.stop();
  });
});

test('a requeue command makes a parked item queued with no attempts and queue:requeued, once even applied twice, and one of a done, a dispatched or a missing item, or of a parked one whose run is still suspended, is rejected naming why', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [{ name: 'a', label: 'sail-a', cap: 2 }],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-a', 'FAKE-3': 'sail-a', 'FAKE-4': 'sail-a', 'FAKE-5': 'sail-a' }),
    );
    const watcher = await w.start(['a']);
    await w.timers.advance(1000);
    await w.spawner.end('FAKE-1', { status: 'failed', stopReason: 'stopped' });
    await w.spawner.end('FAKE-2');
    await w.timers.advance(1000);
    await w.spawner.end('FAKE-4', { status: 'suspended', stopReason: 'interrupted' });
    await w.timers.advance(1000);
    const run4 = w.spawner.run('FAKE-4').runId;
    expect(w.spawner.resumes.map((resume) => resume.runId)).toEqual([run4]);
    w.spawner.endResume(run4, { status: 'suspended', stopReason: 'interrupted', log: 'sail resume: it failed' });
    await w.timers.advance(1000);
    const queue = () => JSON.parse(readFileSync(join(queueDir(w.runs, 'a'), 'queue.json'), 'utf8'));
    const before = queue().items.map((item: Record<string, unknown>) => `${item.dedupKey} ${item.state}`);
    for (const key of ['FAKE-1', 'FAKE-1', 'FAKE-2', 'FAKE-3', 'FAKE-9', 'FAKE-4']) {
      dropCommand(w.runs, { op: 'requeue', workflow: 'a', dedupKey: `ticket:${key}` });
    }
    await w.timers.advance(1000);
    const first = queue().items.find((item: Record<string, unknown>) => item.dedupKey === 'ticket:FAKE-1');
    expect({
      before,
      first,
      requeued: w.events('a').filter((event) => event.type === 'queue:requeued'),
      rejected: rejections(w.out),
    }).toEqual({
      before: [
        'ticket:FAKE-1 parked',
        'ticket:FAKE-2 done',
        'ticket:FAKE-3 dispatched',
        'ticket:FAKE-4 parked',
        'ticket:FAKE-5 dispatched',
      ],
      first: {
        dedupKey: 'ticket:FAKE-1',
        source: { kind: 'ticket', ticketKey: 'FAKE-1' },
        title: 'Ticket FAKE-1',
        url: expect.any(String),
        state: 'queued',
        attempts: 0,
        addedAt: START,
      },
      requeued: [
        expect.objectContaining({ type: 'queue:requeued', dedupKey: 'ticket:FAKE-1', reason: 'requeued by hand' }),
      ],
      rejected: [
        "a's item ticket:FAKE-2 is done: only a parked or failed item is requeued\n",
        "a's item ticket:FAKE-3 is dispatched: only a parked or failed item is requeued\n",
        "a's queue has no item ticket:FAKE-9\n",
        `ticket:FAKE-4 can't be requeued: its run ${run4} is suspended interrupted, and holds its branch: sail resume ${run4} or sail stop ${run4} first\n`,
      ],
    });
    await watcher.stop();
  });
});

test('a drop command takes a parked item out with queue:dropped, dropped by hand, does nothing applied twice, and one of a dispatched item is rejected naming its run', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [{ name: 'a', label: 'sail-a', cap: 1 }],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-a' }),
    );
    const watcher = await w.start(['a']);
    await w.timers.advance(1000);
    await w.spawner.end('FAKE-1', { status: 'failed', stopReason: 'stopped' });
    await w.timers.advance(1000);
    for (const key of ['FAKE-1', 'FAKE-1', 'FAKE-2']) {
      dropCommand(w.runs, { op: 'drop', workflow: 'a', dedupKey: `ticket:${key}` });
    }
    await w.timers.advance(1000);
    const run2 = w.spawner.run('FAKE-2').runId;
    const items = JSON.parse(readFileSync(join(queueDir(w.runs, 'a'), 'queue.json'), 'utf8')).items;
    expect({
      items: items.map((item: Record<string, unknown>) => `${item.dedupKey} ${item.state}`),
      dropped: w
        .events('a')
        .filter((event) => event.type === 'queue:dropped')
        .map(({ dedupKey, reason }) => ({ dedupKey, reason })),
      rejected: rejections(w.out),
    }).toEqual({
      items: ['ticket:FAKE-2 dispatched'],
      dropped: [{ dedupKey: 'ticket:FAKE-1', reason: 'dropped by hand' }],
      rejected: [`ticket:FAKE-2 can't be dropped: its run ${run2} has not ended: sail stop ${run2} first\n`],
    });
    await watcher.stop();
  });
});

test('an add, a requeue and a drop for a workflow outside the set are each rejected, and change no queue', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail-a', cap: 1 },
        { name: 'b', label: 'sail-b', cap: 1 },
      ],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-b' }),
    );
    const watcher = await w.start(['a']);
    await w.timers.advance(1000);
    const queueOfA = () => readFileSync(join(queueDir(w.runs, 'a'), 'queue.json'), 'utf8');
    const before = queueOfA();
    dropCommand(w.runs, { op: 'add', workflow: 'b', ticketKey: 'FAKE-2' });
    dropCommand(w.runs, { op: 'requeue', workflow: 'b', dedupKey: 'ticket:FAKE-2' });
    dropCommand(w.runs, { op: 'drop', workflow: 'b', dedupKey: 'ticket:FAKE-2' });
    await w.timers.advance(1000);
    expect({
      rejected: rejections(w.out),
      a: queueOfA() === before,
      b: existsSync(join(queueDir(w.runs, 'b'), 'queue.json')),
    }).toEqual({
      rejected: Array(3).fill("not watching workflow 'b'\n"),
      a: true,
      b: false,
    });
    await watcher.stop();
  });
});

test('a move command reorders the queue with queue:moved, and one next to a dispatched item is rejected and changes nothing', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [{ name: 'a', label: 'sail-a', cap: 1 }],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-a', 'FAKE-3': 'sail-a' }),
    );
    const watcher = await w.start(['a']);
    await w.timers.advance(1000);
    const file = join(queueDir(w.runs, 'a'), 'queue.json');
    const order = () =>
      JSON.parse(readFileSync(file, 'utf8')).items.map((item: Record<string, unknown>) => `${item.dedupKey}`);
    const start = order();
    dropCommand(w.runs, { op: 'move', workflow: 'a', dedupKey: 'ticket:FAKE-3', before: 'ticket:FAKE-2' });
    await w.timers.advance(1000);
    const moved = order();
    const bytes = readFileSync(file, 'utf8');
    dropCommand(w.runs, { op: 'move', workflow: 'a', dedupKey: 'ticket:FAKE-3', after: 'ticket:FAKE-1' });
    await w.timers.advance(1000);
    expect({
      start,
      moved,
      events: w
        .events('a')
        .filter((event) => event.type === 'queue:moved')
        .map(({ dedupKey, before, reason }) => ({ dedupKey, before, reason })),
      rejected: rejections(w.out),
      unchanged: readFileSync(file, 'utf8') === bytes,
    }).toEqual({
      start: ['ticket:FAKE-1', 'ticket:FAKE-2', 'ticket:FAKE-3'],
      moved: ['ticket:FAKE-1', 'ticket:FAKE-3', 'ticket:FAKE-2'],
      events: [{ dedupKey: 'ticket:FAKE-3', before: 'ticket:FAKE-2', reason: 'moved by hand' }],
      rejected: ["a's item ticket:FAKE-1 is dispatched: only a queued item is moved\n"],
      unchanged: true,
    });
    await watcher.stop();
  });
});

test('a move command with after puts the item directly after its target, with queue:moved naming after (review R6)', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [{ name: 'a', label: 'sail-a', cap: 1 }],
      tickets({ 'FAKE-1': 'sail-a', 'FAKE-2': 'sail-a', 'FAKE-3': 'sail-a', 'FAKE-4': 'sail-a' }),
    );
    const watcher = await w.start(['a']);
    await w.timers.advance(1000);
    const file = join(queueDir(w.runs, 'a'), 'queue.json');
    const order = () =>
      JSON.parse(readFileSync(file, 'utf8')).items.map((item: Record<string, unknown>) => `${item.dedupKey}`);
    dropCommand(w.runs, { op: 'move', workflow: 'a', dedupKey: 'ticket:FAKE-2', after: 'ticket:FAKE-3' });
    await w.timers.advance(1000);
    expect({
      order: order(),
      events: w
        .events('a')
        .filter((event) => event.type === 'queue:moved')
        .map(({ dedupKey, before, after }) => ({ dedupKey, before, after })),
      rejected: rejections(w.out),
    }).toEqual({
      order: ['ticket:FAKE-1', 'ticket:FAKE-3', 'ticket:FAKE-2', 'ticket:FAKE-4'],
      events: [{ dedupKey: 'ticket:FAKE-2', before: undefined, after: 'ticket:FAKE-3' }],
      rejected: [],
    });
    await watcher.stop();
  });
});

test('a ticket workflow and a pull-request workflow that both poll sail open under one watcher, and the registry claims sail once, for the ticket source (ADW-235)', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail', cap: 1 }], tickets({ 'FAKE-1': 'sail' }));
    writePrWorkflow(w.sail, 'r', { watch: { label: 'sail', cap: 1 } });
    seedPullRequests(w.sail, repo, []);
    const started = await w.start(['a', 'r']).catch((error: unknown) => String(error));
    expect({
      watching: typeof started === 'string' ? started : started.watching(),
      labels: readEntry(w.registryDir, 'stub')?.watcher?.labels,
      polled: w
        .events('r')
        .filter((event) => event.type === 'queue:polled')
        .map((event) => event.kind),
    }).toEqual({ watching: ['a', 'r'], labels: ['sail'], polled: ['pr'] });
    if (typeof started !== 'string') await started.stop();
  });
});

test('two pull-request workflows polling sail and Sail are refused, as one label in two cases (review R1-1)', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [], []);
    writePrWorkflow(w.sail, 'r', { watch: { label: 'sail', cap: 1 } });
    writePrWorkflow(w.sail, 's', { watch: { label: 'Sail', cap: 1 } });
    seedPullRequests(w.sail, repo, []);
    const started = await w.start(['r', 's']).catch((error: unknown) => String(error));
    expect(typeof started === 'string' ? started : started.watching()).toBe(
      "Error: workflows 'r' and 's' both poll the label 'Sail'",
    );
    if (typeof started !== 'string') await started.stop();
  });
});

test('two ticket workflows polling sail and Sail open under one watcher: a ticket label matches exactly (review R2)', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(
      repo,
      [
        { name: 'a', label: 'sail', cap: 1 },
        { name: 'b', label: 'Sail', cap: 1 },
      ],
      [],
    );
    const started = await w.start(['a', 'b']).catch((error: unknown) => String(error));
    expect(typeof started === 'string' ? started : started.watching()).toEqual(['a', 'b']);
    if (typeof started !== 'string') await started.stop();
  });
});

test('an add command for a pull-request workflow is rejected, naming what it polls, and queues nothing (review R1-5)', async () => {
  await withTempRepo(async (repo) => {
    const w = await watched(repo, [{ name: 'a', label: 'sail-a', cap: 1 }], tickets({ 'FAKE-1': 'sail-r' }));
    writePrWorkflow(w.sail, 'r', { watch: { label: 'sail-r', cap: 1 } });
    seedPullRequests(w.sail, repo, []);
    const watcher = await w.start(['a', 'r']);
    await w.timers.advance(1000);
    dropCommand(w.runs, { op: 'add', workflow: 'r', ticketKey: 'FAKE-1' });
    await w.timers.advance(1000);
    const items = JSON.parse(readFileSync(join(queueDir(w.runs, 'r'), 'queue.json'), 'utf8')).items;
    expect({ rejected: rejections(w.out), items }).toEqual({
      rejected: ["workflow 'r' polls pull requests: only a workflow that polls tickets takes an add\n"],
      items: [],
    });
    await watcher.stop();
  });
});
