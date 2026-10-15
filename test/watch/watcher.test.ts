// The watcher (DECISIONS D11-D13, D16, D17): the watch set in memory, a poller and a dispatch per workflow, the
// inbox's watch, unwatch and poll commands, its registry field and its stop. On the stub's file-backed fakes in a temp
// repository, fake timers, a temporary registry, and a fake spawner whose runs claim their tickets as they start.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchFor } from '../../src/engine/branch';
import { readConfig } from '../../src/engine/config';
import { commandsDir, dropCommand } from '../../src/watch/inbox';
import { queueDir } from '../../src/watch/queue-store';
import { type RegistryEntry, readEntry } from '../../src/watch/registry';
import { startWatcher, type Watcher } from '../../src/watch/watcher';
import { fakeAdapters } from '../helpers/adapters';
import { fakeTimers } from '../helpers/fake-timers';
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
  const start = async (names: string[]): Promise<Watcher> => {
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
      isAlive: spawner.isAlive,
      write: (text) => out.push(text),
      lines: { timeZone: 'UTC' },
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
