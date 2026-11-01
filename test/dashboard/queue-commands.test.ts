// The dashboard's queue changes over HTTP: a poll, an add, a requeue and a drop dropped as commands in the live watcher's
// inbox, with the checks `sail queue` makes, and the wait for the watcher to take them. A test-side "watcher" stands in
// for the real one: it takes the command file and writes what the real one would, the event and the queue file.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Dashboard, startDashboard } from '../../src/dashboard/server';
import { writeStatus } from '../../src/engine/run-dir';
import type { Command } from '../../src/watch/inbox';
import { entryOf, type Machine, machine } from '../helpers/dashboard';
import { writePrWorkflow } from '../helpers/pr-workflow';
import { writeStub } from '../helpers/stub-workflow';
import { writeTickets } from '../helpers/watched';

let m: Machine;
const servers: Dashboard[] = [];
beforeEach(() => {
  m = machine();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  m.remove();
});

const HEADER = { 'X-Sail-Dashboard': '1' };
const JSON_HEADERS = { ...HEADER, 'Content-Type': 'application/json' };
const WORKFLOW = 'ticket-to-pr';
const WATCHER = `the watcher of 'beta' (pid ${process.pid})`;
const AT = '2026-10-14T09:00:00.000Z';

const item = (key: string, state: string, fields: Record<string, unknown> = {}) => ({
  dedupKey: `ticket:${key}`,
  source: { kind: 'ticket', ticketKey: key },
  title: `Ticket ${key}`,
  url: `fake://tickets/${key}`,
  state,
  attempts: 0,
  addedAt: AT,
  ...fields,
});

/** beta's queue for `workflow`: FAKE-3 dispatched, FAKE-5 queued, FAKE-6 parked, FAKE-7 failed on a running run. */
const ITEMS = [
  item('FAKE-3', 'dispatched', { runId: 'FAKE-3-RUN' }),
  item('FAKE-5', 'queued'),
  item('FAKE-6', 'parked', { attempts: 2, reason: 'it broke' }),
  item('FAKE-7', 'failed', { runId: 'FAKE-7-RUN' }),
];

/** The stub `.sail/` in beta, its tickets, a queue for each of `workflows`, and a live watcher watching them. */
function world({ watcher = true, watched = true, workflows = [WORKFLOW] } = {}) {
  const sail = writeStub(m.beta.clone);
  writeTickets(sail, [
    { key: 'FAKE-1', labels: ['sail'] },
    { key: 'FAKE-2', labels: [] },
    { key: 'FAKE-5', labels: ['sail'] },
    { key: 'FAKE-8', labels: ['sail'], state: { type: 'started', name: 'In Progress' } },
  ]);
  const runs = join(m.beta.clone, '.sail-runs');
  const run = join(runs, 'FAKE-7-RUN');
  mkdirSync(run, { recursive: true });
  writeStatus(run, 'running');
  for (const each of workflows) {
    const dir = join(runs, 'queue', each);
    mkdirSync(dir, { recursive: true });
    writeQueue(dir, each, ITEMS);
    const event = (seq: number, type: string) =>
      `${JSON.stringify({ seq, ts: AT, type, workflow: each, pid: process.pid, label: 'sail', everyMs: 300000, maxConcurrentRuns: 2 })}\n`;
    writeFileSync(
      join(dir, 'events.ndjson'),
      watcher ? `${event(1, 'watch:added')}${watched ? '' : event(2, 'watch:removed')}` : '',
    );
  }
  const live = { pid: process.pid, startedAt: AT, sailDir: m.beta.sailDir, ticketSource: 'fake', labels: ['sail'] };
  writeFileSync(
    join(m.registryDir, 'beta.json'),
    `${JSON.stringify({ ...entryOf(m.beta), ...(watcher ? { watcher: live } : {}) })}\n`,
  );
  const inboxDir = join(runs, 'watcher', 'commands');
  return {
    sail,
    queueDir: (each = WORKFLOW) => join(runs, 'queue', each),
    inbox: () => (existsSync(inboxDir) ? readdirSync(inboxDir) : []),
    inboxDir,
  };
}

function writeQueue(dir: string, workflow: string, items: unknown[]): void {
  writeFileSync(
    join(dir, 'queue.json'),
    `${JSON.stringify({ version: 1, workflow, updatedAt: AT, polling: { label: 'sail', failures: 0 }, items })}\n`,
  );
}

/**
 * The watcher: waits for a command file in the inbox, reads and deletes it, then runs `apply`. Gives the command it took.
 */
async function takes(w: ReturnType<typeof world>, apply?: (command: Command) => void): Promise<Command> {
  const deadline = performance.now() + 5000;
  for (;;) {
    const name = w.inbox().find((each) => each.endsWith('.json'));
    if (name !== undefined) {
      const file = join(w.inboxDir, name);
      const command = JSON.parse(readFileSync(file, 'utf8')) as Command;
      rmSync(file);
      apply?.(command);
      return command;
    }
    if (performance.now() > deadline) throw new Error('no command was dropped within 5 s');
    await Bun.sleep(2);
  }
}

/** Appends the event the watcher emits for an item, and rewrites the queue with `items`. */
function applied(w: ReturnType<typeof world>, type: string, dedupKey: string, items: unknown[], fields = {}): void {
  const dir = w.queueDir();
  const seq = readFileSync(join(dir, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).length + 1;
  appendFileSync(join(dir, 'events.ndjson'), `${JSON.stringify({ seq, ts: AT, type, dedupKey, ...fields })}\n`);
  writeQueue(dir, WORKFLOW, items);
}

function start(options: { applyTimeoutMs?: number } = {}): Dashboard {
  const started = startDashboard({
    registryDir: m.registryDir,
    port: 0,
    env: process.env,
    applyPollMs: 2,
    applyTimeoutMs: options.applyTimeoutMs ?? 5000,
  });
  if ('refused' in started) throw new Error(started.refused);
  servers.push(started);
  return started;
}

const path = (op: string, workflow = WORKFLOW) => `/api/repos/beta/queues/${workflow}/${op}`;
const post = (server: Dashboard, route: string, body: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  fetch(`http://127.0.0.1:${server.port}${route}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const answer = async (response: Response) => [response.status, await response.json()] as const;

test('a poll posted to the dashboard drops a poll command in the live watcher inbox, and answers 200 once the watcher took it', async () => {
  const w = world();
  const server = start();
  const [response, command] = await Promise.all([post(server, path('poll'), {}), takes(w)]);
  expect(command).toEqual({ op: 'poll', workflow: WORKFLOW });
  expect(await answer(response)).toEqual([200, { message: `${WATCHER} polls ${WORKFLOW} now` }]);
});

test('an add posted to the dashboard queues the ticket through the watcher, and answers with the item as sail queue prints it', async () => {
  const w = world();
  const server = start();
  const [response, command] = await Promise.all([
    post(server, path('add'), { ticketKey: 'FAKE-1' }),
    takes(w, () => applied(w, 'queue:item_added', 'ticket:FAKE-1', [...ITEMS, item('FAKE-1', 'queued')])),
  ]);
  expect(command).toEqual({ op: 'add', workflow: WORKFLOW, ticketKey: 'FAKE-1' });
  expect(await answer(response)).toEqual([200, { message: 'queued ticket:FAKE-1 Ticket FAKE-1' }]);
});

test('a forced add of an undesignated ticket drops an add command with force', async () => {
  const w = world();
  const server = start();
  const [response, command] = await Promise.all([
    post(server, path('add'), { ticketKey: 'FAKE-2', force: true }),
    takes(w, () =>
      applied(w, 'queue:item_added', 'ticket:FAKE-2', [...ITEMS, item('FAKE-2', 'queued', { forced: true })]),
    ),
  ]);
  expect(command).toEqual({ op: 'add', workflow: WORKFLOW, ticketKey: 'FAKE-2', force: true });
  expect(await answer(response)).toEqual([200, { message: 'queued ticket:FAKE-2 Ticket FAKE-2 · forced' }]);
});

test('a requeue posted to the dashboard puts a parked item back through the watcher', async () => {
  const w = world();
  const server = start();
  const requeued = ITEMS.map((each) => (each.dedupKey === 'ticket:FAKE-6' ? item('FAKE-6', 'queued') : each));
  const [response, command] = await Promise.all([
    post(server, path('requeue'), { dedupKey: 'ticket:FAKE-6' }),
    takes(w, () => applied(w, 'queue:requeued', 'ticket:FAKE-6', requeued)),
  ]);
  expect(command).toEqual({ op: 'requeue', workflow: WORKFLOW, dedupKey: 'ticket:FAKE-6' });
  expect(await answer(response)).toEqual([200, { message: 'queued ticket:FAKE-6 Ticket FAKE-6' }]);
});

test('a drop posted to the dashboard takes the item out through the watcher', async () => {
  const w = world();
  const server = start();
  const [response, command] = await Promise.all([
    post(server, path('drop'), { dedupKey: 'ticket:FAKE-6' }),
    takes(w, () =>
      applied(
        w,
        'queue:dropped',
        'ticket:FAKE-6',
        ITEMS.filter((each) => each.dedupKey !== 'ticket:FAKE-6'),
        { reason: 'dropped by hand' },
      ),
    ),
  ]);
  expect(command).toEqual({ op: 'drop', workflow: WORKFLOW, dedupKey: 'ticket:FAKE-6' });
  expect(await answer(response)).toEqual([200, { message: 'ticket:FAKE-6 dropped' }]);
});

test.each([
  [
    'an add of a ticket without the label',
    'add',
    { ticketKey: 'FAKE-2' },
    "the ticket is not designated: it carries no 'sail' label.",
  ],
  ['an add of a ticket not in a pick-up state', 'add', { ticketKey: 'FAKE-8' }, 'In Progress'],
  [
    'an add of a ticket already queued',
    'add',
    { ticketKey: 'FAKE-5' },
    "ticket:FAKE-5 is in ticket-to-pr's queue already: queued ticket:FAKE-5 Ticket FAKE-5",
  ],
  ['an add of a ticket the tracker lacks', 'add', { ticketKey: 'FAKE-99' }, 'FAKE-99'],
  [
    'a requeue of a queued item',
    'requeue',
    { dedupKey: 'ticket:FAKE-5' },
    'ticket:FAKE-5 is queued: only a parked or failed item is requeued',
  ],
  [
    'a requeue of a failed item whose run is running',
    'requeue',
    { dedupKey: 'ticket:FAKE-7' },
    "ticket:FAKE-7 can't be requeued: its run FAKE-7-RUN is running, and holds its branch: sail resume FAKE-7-RUN or sail stop FAKE-7-RUN first",
  ],
  [
    'a drop of a dispatched item',
    'drop',
    { dedupKey: 'ticket:FAKE-3' },
    "ticket:FAKE-3 can't be dropped: its run FAKE-3-RUN has not ended: sail stop FAKE-3-RUN first",
  ],
  [
    'a requeue of an unknown item',
    'requeue',
    { dedupKey: 'ticket:FAKE-9' },
    "ticket-to-pr's queue has no item ticket:FAKE-9",
  ],
  [
    'a drop of an unknown item',
    'drop',
    { dedupKey: 'ticket:FAKE-9' },
    "ticket-to-pr's queue has no item ticket:FAKE-9",
  ],
] as const)('%s is refused with 409 and the sail queue message, and drops no command', async (_, op, body, message) => {
  const w = world();
  const server = start();
  const response = await post(server, path(op), body);
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: string }).error).toContain(message);
  expect(w.inbox()).toEqual([]);
});

test('an add to a workflow that polls pull requests is refused with the sail queue message, and drops no command', async () => {
  const w = world({ workflows: [WORKFLOW, 'review-pr'] });
  writePrWorkflow(w.sail, 'review-pr', { watch: { label: 'sail', cap: 1 } });
  const server = start();
  const response = await post(server, path('add', 'review-pr'), { ticketKey: 'FAKE-1' });
  expect(await answer(response)).toEqual([
    409,
    { error: "workflow 'review-pr' polls pull requests: only a workflow that polls tickets takes an add" },
  ]);
  expect(w.inbox()).toEqual([]);
});

test.each([
  ['poll', {}],
  ['add', { ticketKey: 'FAKE-1' }],
  ['requeue', { dedupKey: 'ticket:FAKE-6' }],
  ['drop', { dedupKey: 'ticket:FAKE-6' }],
] as const)('a %s with no live watcher is 409 naming sail watch, and drops no command', async (op, body) => {
  const w = world({ watcher: false });
  const server = start();
  const response = await post(server, path(op), body);
  expect(await answer(response)).toEqual([
    409,
    { error: "no watcher is running for 'beta': sail watch ticket-to-pr first" },
  ]);
  expect(w.inbox()).toEqual([]);
});

test.each([
  ['poll', {}],
  ['add', { ticketKey: 'FAKE-1' }],
  ['requeue', { dedupKey: 'ticket:FAKE-6' }],
  ['drop', { dedupKey: 'ticket:FAKE-6' }],
] as const)('a %s for a workflow the live watcher does not watch is 409, and drops no command', async (op, body) => {
  const w = world({ watched: false });
  const server = start();
  const response = await post(server, path(op), body);
  expect(await answer(response)).toEqual([
    409,
    { error: `${WATCHER} does not watch 'ticket-to-pr': sail watch ticket-to-pr first` },
  ]);
  expect(w.inbox()).toEqual([]);
});

test.each(['poll', 'add', 'requeue', 'drop'])(
  'a POST to %s is refused for no client header, a text body or a foreign Origin',
  async (op) => {
    const w = world();
    const server = start();
    const body = { ticketKey: 'FAKE-1', dedupKey: 'ticket:FAKE-6' };
    const results = [
      (await post(server, path(op), body, { 'Content-Type': 'application/json' })).status,
      (await post(server, path(op), body, { ...HEADER, 'Content-Type': 'text/plain' })).status,
      (await post(server, path(op), body, { ...JSON_HEADERS, Origin: 'http://evil.example' })).status,
    ];
    expect(results).toEqual([403, 415, 403]);
    expect(w.inbox()).toEqual([]);
  },
);

test.each([
  ['a poll with a field', 'poll', { workflow: 'x' }],
  ['an add with no ticket key', 'add', {}],
  ['an add with a non-boolean force', 'add', { ticketKey: 'FAKE-1', force: 'yes' }],
  ['a drop with no dedup key', 'drop', {}],
  ['a requeue with a field it does not take', 'requeue', { dedupKey: 'ticket:FAKE-6', force: true }],
  ['a body that is not JSON', 'drop', 'not json'],
] as const)('%s is refused with 400, and drops no command', async (_, op, body) => {
  const w = world();
  const server = start();
  const response = await post(server, path(op), body);
  expect(response.status).toBe(400);
  expect(w.inbox()).toEqual([]);
});

test('a command the watcher has not taken in time is answered 202 waiting in the inbox', async () => {
  const w = world();
  const server = start({ applyTimeoutMs: 50 });
  const response = await post(server, path('drop'), { dedupKey: 'ticket:FAKE-6' });
  const [status, body] = await answer(response);
  expect(status).toBe(202);
  expect(body).toEqual({
    waiting: expect.stringMatching(
      new RegExp(
        `^${WATCHER.replace(/[()]/g, '\\$&')} has not taken the command yet: it waits in \\.sail-runs/watcher/commands/.+\\.json$`,
      ),
    ),
  });
  expect(w.inbox()).toHaveLength(1);
});

test('a command the watcher took without applying is 409 with its terminal says why', async () => {
  const w = world();
  const server = start();
  const [response] = await Promise.all([post(server, path('drop'), { dedupKey: 'ticket:FAKE-6' }), takes(w)]);
  expect(await answer(response)).toEqual([
    409,
    { error: 'the watcher did not drop ticket:FAKE-6: its terminal says why' },
  ]);
});

test('an add the watcher applied and then dropped is 409 with the reason', async () => {
  const w = world();
  const server = start();
  const [response] = await Promise.all([
    post(server, path('add'), { ticketKey: 'FAKE-1' }),
    takes(w, () => {
      applied(w, 'queue:item_added', 'ticket:FAKE-1', ITEMS);
      applied(w, 'queue:dropped', 'ticket:FAKE-1', ITEMS, { reason: 'left In Progress' });
    }),
  ]);
  expect(await answer(response)).toEqual([
    409,
    { error: 'the watcher added ticket:FAKE-1, then dropped it: left In Progress' },
  ]);
});

test('a queue change for an unregistered repository or a workflow with no queue is 404', async () => {
  world();
  const server = start();
  expect((await post(server, '/api/repos/gamma/queues/ticket-to-pr/poll', {})).status).toBe(404);
  expect((await post(server, path('poll', 'other'), {})).status).toBe(404);
});
