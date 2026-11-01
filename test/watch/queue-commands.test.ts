// src/watch/queue-commands.ts: the checks `sail queue` and the dashboard make before they drop a command, the command
// they drop, and the reading of what the watcher did with it. The ticket source is the fake one, over a temp
// repository's stub `.sail/`; a queue is a hand-written queue.json and events.ndjson.
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeTicketSource } from '../../src/adapters/fake/ticket-source';
import { writeStatus } from '../../src/engine/run-dir';
import { commandTaken } from '../../src/watch/inbox';
import { type CommandOptions, commandFor, itemLine, outcomeOf, streamMark } from '../../src/watch/queue-commands';
import { type QueueFile, type QueueItem, queueDir } from '../../src/watch/queue-store';
import { writePrWorkflow } from '../helpers/pr-workflow';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';
import { writeTickets, writeWatched } from '../helpers/watched';

const NOW = '2026-10-15T09:00:00.000Z';

const item = (ticketKey: string, fields: Partial<QueueItem> = {}): QueueItem => ({
  dedupKey: `ticket:${ticketKey}`,
  source: { kind: 'ticket', ticketKey },
  title: `Ticket ${ticketKey}`,
  url: `fake://tickets/${ticketKey}`,
  state: 'queued',
  attempts: 0,
  addedAt: NOW,
  ...fields,
});

/** A repository with watched workflow `a` (label sail-a), a queue holding `items`, and the tickets given. */
function world(
  repo: TempRepo,
  items: QueueItem[],
  tickets: { key: string; labels: string[]; state?: { type: string; name: string } }[] = [],
) {
  const sail = writeStub(repo.dir);
  writeWatched(sail, 'a', { label: 'sail-a', cap: 1 });
  writeTickets(sail, tickets);
  const runs = join(repo.dir, '.sail-runs');
  const dir = queueDir(runs, 'a');
  mkdirSync(dir, { recursive: true });
  const file: QueueFile = {
    version: 1,
    workflow: 'a',
    updatedAt: NOW,
    polling: { label: 'sail-a', failures: 0 },
    items,
  };
  writeFileSync(join(dir, 'queue.json'), `${JSON.stringify(file)}\n`);
  const ticketSource = createFakeTicketSource({
    seed: join(sail, 'fake', 'tickets.json'),
    state: join(repo.dir, 'fake-state.json'),
  });
  const options: CommandOptions = {
    runs,
    sailDir: sail,
    config: { label: 'sail' },
    workflow: 'a',
    label: 'sail-a',
    ticketSource,
  };
  const events = (lines: Record<string, unknown>[]) =>
    writeFileSync(join(dir, 'events.ndjson'), lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  return { sail, runs, dir, options, events };
}

test('a poll is the poll command for the workflow, with no item', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, []);
    expect(await commandFor('poll', w.options)).toEqual({ command: { op: 'poll', workflow: 'a' } });
  });
});

test('an add of a designated ticket in a pick-up state is the add command, and its key is the dedup key', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [], [{ key: 'FAKE-1', labels: ['sail-a'] }]);
    expect(await commandFor('add', { ...w.options, ref: 'FAKE-1' })).toEqual({
      command: { op: 'add', workflow: 'a', ticketKey: 'FAKE-1' },
      key: 'ticket:FAKE-1',
    });
  });
});

test('a forced add of an undesignated ticket is the add command with force', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [], [{ key: 'FAKE-1', labels: [] }]);
    expect(await commandFor('add', { ...w.options, ref: 'FAKE-1', force: true })).toEqual({
      command: { op: 'add', workflow: 'a', ticketKey: 'FAKE-1', force: true },
      key: 'ticket:FAKE-1',
    });
  });
});

test('an add of an undesignated ticket is refused unless forced', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [], [{ key: 'FAKE-1', labels: ['other'] }]);
    const refused = await commandFor('add', { ...w.options, ref: 'FAKE-1' });
    expect(refused).toEqual({ refused: expect.stringContaining('sail-a') });
  });
});

test('an add of a ticket not in a pick-up state is refused', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [], [{ key: 'FAKE-1', labels: ['sail-a'], state: { type: 'started', name: 'In Progress' } }]);
    const refused = await commandFor('add', { ...w.options, ref: 'FAKE-1' });
    expect(refused).toEqual({ refused: expect.stringContaining('In Progress') });
  });
});

test('an add of a ticket already queued is refused with the item as `sail queue ls` prints it', async () => {
  await withTempRepo(async (repo) => {
    const queued = item('FAKE-1');
    const w = world(repo, [queued], [{ key: 'FAKE-1', labels: ['sail-a'] }]);
    expect(await commandFor('add', { ...w.options, ref: 'FAKE-1' })).toEqual({
      refused: `ticket:FAKE-1 is in a's queue already: queued ticket:FAKE-1 Ticket FAKE-1`,
    });
  });
});

test('an add of a ticket whose earlier item is done is built', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [item('FAKE-1', { state: 'done' })], [{ key: 'FAKE-1', labels: ['sail-a'] }]);
    expect(await commandFor('add', { ...w.options, ref: 'FAKE-1' })).toEqual({
      command: { op: 'add', workflow: 'a', ticketKey: 'FAKE-1' },
      key: 'ticket:FAKE-1',
    });
  });
});

test('an add to a workflow that polls pull requests is refused', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [], [{ key: 'FAKE-1', labels: ['sail-a'] }]);
    writePrWorkflow(w.sail, 'prs', { watch: { label: 'sail-a', cap: 1 } });
    const refused = await commandFor('add', { ...w.options, workflow: 'prs', ref: 'FAKE-1' });
    expect(refused).toEqual({ refused: expect.stringContaining('prs') });
    expect('refused' in refused && refused.refused).toContain('pull request');
  });
});

test('an item the queue does not hold is refused by its name', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [item('FAKE-1')]);
    for (const op of ['requeue', 'drop'] as const) {
      expect(await commandFor(op, { ...w.options, ref: 'FAKE-9' })).toEqual({
        refused: "a's queue has no item FAKE-9",
      });
    }
  });
});

test('a drop names the item by its dedup key, whether given the ticket key or the dedup key', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [item('FAKE-1')]);
    const expected = {
      command: { op: 'drop' as const, workflow: 'a', dedupKey: 'ticket:FAKE-1' },
      key: 'ticket:FAKE-1',
    };
    expect(await commandFor('drop', { ...w.options, ref: 'FAKE-1' })).toEqual(expected);
    expect(await commandFor('drop', { ...w.options, ref: 'ticket:FAKE-1' })).toEqual(expected);
  });
});

test('a dispatched item is not dropped', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [item('FAKE-3', { state: 'dispatched', runId: 'FAKE-3-RUN' })]);
    expect(await commandFor('drop', { ...w.options, ref: 'FAKE-3' })).toEqual({
      refused: "ticket:FAKE-3 can't be dropped: its run FAKE-3-RUN has not ended: sail stop FAKE-3-RUN first",
    });
  });
});

test('only a parked or failed item is requeued', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [item('FAKE-1')]);
    expect(await commandFor('requeue', { ...w.options, ref: 'FAKE-1' })).toEqual({
      refused: 'ticket:FAKE-1 is queued: only a parked or failed item is requeued',
    });
  });
});

test('a failed item whose run is still running is not requeued', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [item('FAKE-1', { state: 'failed', runId: 'RUN-1' })]);
    const runDir = join(w.runs, 'RUN-1');
    mkdirSync(runDir, { recursive: true });
    writeStatus(runDir, 'running');
    expect(await commandFor('requeue', { ...w.options, ref: 'FAKE-1' })).toEqual({
      refused:
        "ticket:FAKE-1 can't be requeued: its run RUN-1 is running, and holds its branch: sail resume RUN-1 or sail stop RUN-1 first",
    });
  });
});

test('a parked item and a failed item whose run has ended are requeued', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [item('FAKE-1', { state: 'parked' }), item('FAKE-2', { state: 'failed', runId: 'RUN-2' })]);
    const runDir = join(w.runs, 'RUN-2');
    mkdirSync(runDir, { recursive: true });
    writeStatus(runDir, 'failed', 'stopped');
    expect(await commandFor('requeue', { ...w.options, ref: 'FAKE-1' })).toEqual({
      command: { op: 'requeue', workflow: 'a', dedupKey: 'ticket:FAKE-1' },
      key: 'ticket:FAKE-1',
    });
    expect(await commandFor('requeue', { ...w.options, ref: 'FAKE-2' })).toEqual({
      command: { op: 'requeue', workflow: 'a', dedupKey: 'ticket:FAKE-2' },
      key: 'ticket:FAKE-2',
    });
  });
});

test('a move puts a queued item before or after another queued one, and refuses the rest', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [item('FAKE-1'), item('FAKE-2'), item('FAKE-3', { state: 'parked' })]);
    expect(await commandFor('move', { ...w.options, ref: 'FAKE-1', before: 'FAKE-2' })).toEqual({
      command: { op: 'move', workflow: 'a', dedupKey: 'ticket:FAKE-1', before: 'ticket:FAKE-2' },
      key: 'ticket:FAKE-1',
    });
    expect(await commandFor('move', { ...w.options, ref: 'FAKE-1', after: 'FAKE-2' })).toEqual({
      command: { op: 'move', workflow: 'a', dedupKey: 'ticket:FAKE-1', after: 'ticket:FAKE-2' },
      key: 'ticket:FAKE-1',
    });
    expect(await commandFor('move', { ...w.options, ref: 'FAKE-1', after: 'FAKE-1' })).toEqual({
      refused: "ticket:FAKE-1 can't be moved next to itself",
    });
    expect(await commandFor('move', { ...w.options, ref: 'FAKE-1', after: 'FAKE-3' })).toEqual({
      refused: 'ticket:FAKE-3 is parked: only a queued item is moved',
    });
    expect(await commandFor('move', { ...w.options, ref: 'FAKE-1', after: 'FAKE-9' })).toEqual({
      refused: "a's queue has no item FAKE-9",
    });
  });
});

test('itemLine prints the state, key and title, then the details that apply', () => {
  expect(
    itemLine(item('FAKE-1', { state: 'failed', attempts: 2, priority: 'high', reason: 'boom', forced: true })),
  ).toBe('failed ticket:FAKE-1 Ticket FAKE-1 · priority high, 2 attempts, forced, boom');
});

test('the stream mark is the highest seq in the queue event stream, 0 without one', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, []);
    expect(streamMark(w.runs, 'a')).toBe(0);
    w.events([
      { seq: 3, type: 'queue:polled' },
      { seq: 7, type: 'queue:polled' },
      { seq: 5, type: 'queue:polled' },
    ]);
    expect(streamMark(w.runs, 'a')).toBe(7);
  });
});

test('an applied change is read back as the item the queue file holds', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [item('FAKE-1', { state: 'queued' })]);
    w.events([
      { seq: 1, type: 'queue:requeued', dedupKey: 'ticket:FAKE-1' },
      { seq: 2, type: 'queue:requeued', dedupKey: 'ticket:FAKE-1' },
    ]);
    const outcome = outcomeOf(w.runs, 'a', 'requeue', 'ticket:FAKE-1', 1);
    expect(outcome).toEqual({ applied: item('FAKE-1', { state: 'queued' }) });
  });
});

test('a drop that was applied reads back as no item', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, []);
    w.events([{ seq: 4, type: 'queue:dropped', dedupKey: 'ticket:FAKE-1', reason: 'dropped by hand' }]);
    expect(outcomeOf(w.runs, 'a', 'drop', 'ticket:FAKE-1', 3)).toEqual({ applied: undefined });
  });
});

test('a command the watcher took without an event for the item is not applied', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, [item('FAKE-6', { state: 'parked' })]);
    w.events([
      { seq: 1, type: 'queue:dropped', dedupKey: 'ticket:FAKE-6' },
      { seq: 5, type: 'queue:requeued', dedupKey: 'ticket:FAKE-2' },
    ]);
    expect(outcomeOf(w.runs, 'a', 'drop', 'ticket:FAKE-6', 2)).toEqual({
      refused: 'the watcher did not drop ticket:FAKE-6: its terminal says why',
    });
  });
});

test('an add the watcher applied and then dropped is refused with the drop reason', async () => {
  await withTempRepo(async (repo) => {
    const w = world(repo, []);
    w.events([
      { seq: 1, type: 'queue:item_added', dedupKey: 'ticket:FAKE-1' },
      { seq: 2, type: 'queue:dropped', dedupKey: 'ticket:FAKE-1', reason: 'left In Progress' },
    ]);
    expect(outcomeOf(w.runs, 'a', 'add', 'ticket:FAKE-1', 0)).toEqual({
      refused: 'the watcher added ticket:FAKE-1, then dropped it: left In Progress',
    });
  });
});

test('a command file still in the inbox is not taken in time, one that is gone is', async () => {
  await withTempRepo(async (repo) => {
    const file = join(repo.dir, 'command.json');
    writeFileSync(file, '{}');
    expect(await commandTaken(file, { timeoutMs: 30, pollMs: 5 })).toBe(false);
    expect(await commandTaken(join(repo.dir, 'gone.json'), { timeoutMs: 30, pollMs: 5 })).toBe(true);
  });
});
