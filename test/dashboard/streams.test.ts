// The dashboard's WebSockets: `?run=` replays a run's events and follows it until it ends, `?index=1` sends every
// repository's runs and queues and again when they change, and `?queue=` replays a watched workflow's queue events and
// follows them until the client closes. Targets are refused over HTTP before any upgrade, and an upgrade needs this
// dashboard as its Origin, or the client header. Every wait polls for its condition
// against a deadline, so a broken stream fails an assertion rather than hanging.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Dashboard, startDashboard } from '../../src/dashboard/server';
import { openRunStream } from '../../src/dashboard/streams';
import {
  eventLines,
  GOLDEN_RUN_ID,
  type Machine,
  machine,
  QUEUE_WORKFLOW,
  queueDirOf,
  seedFixtures,
  treeHash,
} from '../helpers/dashboard';
import { copyGoldenRun } from '../helpers/golden-run';

let m: Machine;
let servers: Dashboard[] = [];
beforeEach(() => {
  m = machine();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  m.remove();
});

const HEADER = { 'X-Sail-Dashboard': '1' };
const RUNNING_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD9Z';
/** What a refused upgrade sends, beside the target and the Origin under test. */
const UPGRADE = {
  Upgrade: 'websocket',
  Connection: 'Upgrade',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version': '13',
};

function start(registryDir = m.registryDir): Dashboard {
  const started = startDashboard({ registryDir, port: 0, followPollMs: 20, indexPollMs: 30 });
  if ('refused' in started) throw new Error(`the dashboard refused to start: ${started.refused}`);
  servers.push(started);
  return started;
}

// biome-ignore lint/suspicious/noExplicitAny: messages are whatever the server sent, checked by each test
type Received = any;

interface Conversation {
  messages: Received[];
  closed: number | undefined;
  close(): void;
}

/** A WebSocket on `/ws?<query>`, recording every message and the close code. */
function connect(server: Dashboard, query: string, headers: Record<string, string> = HEADER): Conversation {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?${query}`, { headers } as unknown as string[]);
  const conversation: Conversation = { messages: [], closed: undefined, close: () => ws.close() };
  ws.onmessage = (message) => conversation.messages.push(JSON.parse(String(message.data)));
  ws.onclose = (event) => {
    conversation.closed = event.code;
  };
  return conversation;
}

/** Waits until `condition` holds, polling every 10 ms, for at most `ms`. Returns whether it held. */
async function until(condition: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(10);
  }
  return true;
}

const events = (conversation: Conversation) =>
  conversation.messages.filter((message) => message.kind === 'event').map((message) => message.event.seq);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A copy of the golden run in alpha that is still running: STATUS `running` and its first `count` events. */
function runningRun(count: number): { dir: string; rest: string[] } {
  const dir = copyGoldenRun(m.alpha.clone, { runId: RUNNING_ID, status: 'running\n' });
  const lines = eventLines(dir);
  writeFileSync(
    join(dir, 'events.ndjson'),
    lines
      .slice(0, count)
      .map((line) => `${line}\n`)
      .join(''),
  );
  return { dir, rest: lines.slice(count) };
}

const append = (dir: string, lines: string[]) =>
  appendFileSync(join(dir, 'events.ndjson'), lines.map((line) => `${line}\n`).join(''));

/** The status an upgrade of `/ws?<query>` gets when it is refused, or 101 when it isn't. */
async function upgradeStatus(server: Dashboard, query: string, headers: Record<string, string>): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${server.port}/ws?${query}`, { headers: { ...UPGRADE, ...headers } });
  return response.status;
}

test('a finished run replays every event in seq order, then end, then a close with 1000, and changes nothing', async () => {
  const server = start();
  const before = treeHash(m.root);
  const socket = connect(server, `run=alpha/${GOLDEN_RUN_ID}`);
  expect(await until(() => socket.closed !== undefined)).toBe(true);
  const count = eventLines(m.alpha.runDir).length;
  expect(events(socket)).toEqual(range(1, count));
  expect(socket.messages).toHaveLength(count + 1);
  expect(socket.messages.at(-1)).toEqual({ kind: 'end' });
  expect(socket.closed).toBe(1000);
  expect(treeHash(m.root)).toBe(before);
}, 15_000);

test('a running run replays what it has, then delivers each append in order, then end once it has ended', async () => {
  const { dir, rest } = runningRun(40);
  const server = start();
  const socket = connect(server, `run=alpha/${RUNNING_ID}`);
  expect(await until(() => events(socket).length === 40)).toBe(true);
  append(dir, rest.slice(0, 30));
  expect(await until(() => events(socket).length === 70)).toBe(true);
  expect(socket.closed).toBeUndefined();
  writeFileSync(join(dir, 'STATUS'), 'completed\n');
  append(dir, rest.slice(30));
  expect(await until(() => socket.closed !== undefined)).toBe(true);
  expect(events(socket)).toEqual(range(1, 40 + rest.length));
  expect(socket.messages.at(-1)).toEqual({ kind: 'end' });
  expect(socket.closed).toBe(1000);
}, 15_000);

test('a line that cannot be read sends an error naming it, then a close with 1011', async () => {
  const lines = eventLines(m.alpha.runDir);
  lines[2] = '{"seq": 3, "type": ';
  writeFileSync(join(m.alpha.runDir, 'events.ndjson'), lines.map((line) => `${line}\n`).join(''));
  const server = start();
  const socket = connect(server, `run=alpha/${GOLDEN_RUN_ID}`);
  expect(await until(() => socket.closed !== undefined)).toBe(true);
  expect(socket.messages.at(-1)).toEqual({ kind: 'error', message: expect.stringContaining('events.ndjson:3') });
  expect(socket.closed).toBe(1011);
}, 15_000);

test('the index lists every repository with its runs at once, stays quiet while nothing changes, and resends on a new run', async () => {
  const server = start();
  const socket = connect(server, 'index=1');
  expect(await until(() => socket.messages.length > 0)).toBe(true);
  const runsOf = (message: Received) =>
    message.repos.map((repo: Received) => [repo.name, repo.runs.map((run: Received) => run.runId)]);
  expect(socket.messages[0].kind).toBe('index');
  expect(runsOf(socket.messages[0])).toEqual([
    ['alpha', [GOLDEN_RUN_ID]],
    ['beta', [GOLDEN_RUN_ID]],
  ]);
  // Ten poll intervals with nothing changed.
  await Bun.sleep(300);
  expect(socket.messages).toHaveLength(1);
  copyGoldenRun(m.alpha.clone, { runId: RUNNING_ID, startedAt: '2026-09-26T09:00:00.000Z' });
  expect(await until(() => socket.messages.length > 1)).toBe(true);
  expect(runsOf(socket.messages.at(-1))).toEqual([
    ['alpha', [GOLDEN_RUN_ID, RUNNING_ID]],
    ['beta', [GOLDEN_RUN_ID]],
  ]);
}, 15_000);

test('stopping a run stream stops its follow: nothing is sent after it, though the run goes on', async () => {
  const { dir, rest } = runningRun(10);
  const sent: Received[] = [];
  const closes: (number | undefined)[] = [];
  const stop = openRunStream(
    { send: (text) => sent.push(JSON.parse(text)), close: (code) => closes.push(code) },
    dir,
    20,
  );
  expect(await until(() => sent.length === 10)).toBe(true);
  stop();
  append(dir, rest.slice(0, 5));
  // Ten poll intervals, with five new events on disk.
  await Bun.sleep(200);
  expect(sent.map((message) => message.event.seq)).toEqual(range(1, 10));
  expect(closes).toEqual([]);
}, 15_000);

test('stop() closes a socket that is still following a running run, and resolves', async () => {
  runningRun(10);
  const server = start();
  const socket = connect(server, `run=alpha/${RUNNING_ID}`);
  expect(await until(() => events(socket).length === 10)).toBe(true);
  servers = [];
  const stopped = await Promise.race([server.stop().then(() => true), Bun.sleep(4000).then(() => false)]);
  expect(stopped).toBe(true);
  expect(await until(() => socket.closed !== undefined)).toBe(true);
}, 15_000);

test.each([
  ['an unregistered repository', 'run=gamma/x', 404],
  ['a run id of ..', 'run=alpha/..', 404],
  ['a run id with a separator', `run=alpha/${GOLDEN_RUN_ID}/00-intake`, 404],
  ['no target', '', 400],
  ['two targets', `run=alpha/${GOLDEN_RUN_ID}&index=1`, 400],
] as const)(
  'a WebSocket on %s is refused before the upgrade, and the golden run opens',
  async (_, query, status) => {
    const server = start();
    const socket = connect(server, `run=beta/${GOLDEN_RUN_ID}`);
    expect(await until(() => socket.closed !== undefined)).toBe(true);
    expect(socket.messages.at(-1)).toEqual({ kind: 'end' });
    const response = await fetch(`http://127.0.0.1:${server.port}/ws?${query}`, { headers: { ...UPGRADE, ...HEADER } });
    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: string };
    expect(body).toEqual({ error: expect.any(String) });
  },
  15_000,
);

test("an upgrade from this dashboard's own origin needs no header, by address or as localhost", async () => {
  const server = start();
  for (const host of ['127.0.0.1', 'localhost']) {
    const socket = connect(server, `run=alpha/${GOLDEN_RUN_ID}`, { Origin: `http://${host}:${server.port}` });
    expect(await until(() => socket.closed !== undefined)).toBe(true);
    expect(socket.messages.at(-1)).toEqual({ kind: 'end' });
  }
}, 15_000);

test.each([
  ['another origin, even with the header', () => ({ ...HEADER, Origin: 'http://evil.example' })],
  ['this host on another port', (port: number) => ({ Origin: `http://127.0.0.1:${port + 1}` })],
  ['neither an origin nor the header', () => ({})],
  ['another Host', (port: number) => ({ ...HEADER, Host: `evil.example:${port}` })],
] as const)(
  'an upgrade with %s gets 403',
  async (_, headers) => {
    const server = start();
    expect(await upgradeStatus(server, `run=alpha/${GOLDEN_RUN_ID}`, headers(server.port))).toBe(403);
  },
  15_000,
);

test('an events.ndjson that links out of the run is refused before the upgrade, and one swapped in mid-follow ends the stream with an error (review #1.1)', async () => {
  rmSync(join(m.alpha.runDir, 'events.ndjson'));
  symlinkSync(join(m.beta.runDir, 'events.ndjson'), join(m.alpha.runDir, 'events.ndjson'));
  const server = start();
  expect(await upgradeStatus(server, `run=alpha/${GOLDEN_RUN_ID}`, HEADER)).toBe(404);
  const { dir } = runningRun(40);
  const socket = connect(server, `run=alpha/${RUNNING_ID}`);
  expect(await until(() => events(socket).length === 40)).toBe(true);
  symlinkSync(join(m.beta.runDir, 'events.ndjson'), join(dir, 'events.link'));
  renameSync(join(dir, 'events.link'), join(dir, 'events.ndjson'));
  expect(await until(() => socket.closed !== undefined)).toBe(true);
  expect(events(socket)).toEqual(range(1, 40));
  expect(socket.messages.at(-1)).toEqual({ kind: 'error', message: expect.stringContaining('events.ndjson') });
  expect(socket.closed).toBe(1011);
}, 15_000);

test('a repository whose runs cannot be listed gets a problem in the index, and a registry that cannot be read stalls nothing (review #1.4)', async () => {
  const server = start();
  const socket = connect(server, 'index=1');
  expect(await until(() => socket.messages.length > 0)).toBe(true);
  renameSync(join(m.alpha.clone, '.sail-runs'), join(m.alpha.clone, 'runs-moved'));
  writeFileSync(join(m.alpha.clone, '.sail-runs'), 'not a directory\n');
  copyGoldenRun(m.beta.clone, { runId: RUNNING_ID, startedAt: '2026-09-26T09:00:00.000Z' });
  expect(await until(() => socket.messages.length > 1)).toBe(true);
  const latest = socket.messages.at(-1).repos;
  expect(latest.map((repo: Received) => [repo.name, repo.runs.length, typeof repo.problem])).toEqual([
    ['alpha', 0, 'string'],
    ['beta', 2, 'undefined'],
  ]);
  renameSync(m.registryDir, `${m.registryDir}-moved`);
  writeFileSync(m.registryDir, 'not a directory\n');
  const late = connect(server, 'index=1');
  await Bun.sleep(100);
  rmSync(m.registryDir);
  renameSync(`${m.registryDir}-moved`, m.registryDir);
  expect(await until(() => late.messages.length > 0)).toBe(true);
  expect(late.messages.at(-1).repos.map((repo: Received) => repo.name)).toEqual(['alpha', 'beta']);
  const listed = await fetch(`http://127.0.0.1:${server.port}/api/repos`, { headers: HEADER });
  expect(listed.status).toBe(200);
}, 15_000);

test('a STATUS that links out of the run is refused before the upgrade, and a FIFO swapped in mid-follow ends the stream with an error (review #2.2)', async () => {
  rmSync(join(m.alpha.runDir, 'STATUS'));
  symlinkSync(join(m.outside, 'secret.txt'), join(m.alpha.runDir, 'STATUS'));
  const server = start();
  expect(await upgradeStatus(server, `run=alpha/${GOLDEN_RUN_ID}`, HEADER)).toBe(404);
  const { dir, rest } = runningRun(40);
  const socket = connect(server, `run=alpha/${RUNNING_ID}`);
  expect(await until(() => events(socket).length === 40)).toBe(true);
  Bun.spawnSync(['mkfifo', join(dir, 'STATUS.fifo')]);
  renameSync(join(dir, 'STATUS.fifo'), join(dir, 'STATUS'));
  // Unblocks a server that opened the FIFO, so a broken check fails an assertion rather than hanging the test.
  const writer = Bun.spawn(['sh', '-c', `sleep 2; printf 'completed\\n' > '${join(dir, 'STATUS')}'`]);
  try {
    append(dir, rest);
    expect(await until(() => socket.closed !== undefined)).toBe(true);
    expect(socket.messages.at(-1)).toEqual({ kind: 'error', message: expect.stringContaining('STATUS') });
    expect(socket.closed).toBe(1011);
  } finally {
    writer.kill();
  }
}, 15_000);

test('a message the socket drops ends the replay with a close of 1011, never with end (review #3.1)', async () => {
  const sent: Received[] = [];
  const closes: (number | undefined)[] = [];
  const send = (text: string) => {
    const message = JSON.parse(text);
    // Bun's send() answers 0 for a message it dropped.
    if (message.event?.seq === 3) return 0;
    return sent.push(message);
  };
  openRunStream({ send, close: (code) => closes.push(code) }, m.alpha.runDir, 20);
  expect(await until(() => closes.length > 0)).toBe(true);
  await Bun.sleep(100);
  expect(closes).toEqual([1011]);
  expect(sent.map((message) => message.kind)).toEqual(['event', 'event']);
}, 15_000);

/** A seeded machine, removed after the test, and a dashboard over it. */
function seeded(): { s: Machine; server: Dashboard } {
  const s = seedFixtures();
  extra.push(s);
  return { s, server: start(s.registryDir) };
}
const extra: Machine[] = [];
afterEach(() => {
  for (const s of extra.splice(0)) s.remove();
});

const queueEvents = (conversation: Conversation) =>
  conversation.messages.filter((message) => message.kind === 'queue-event').map((message) => message.event.seq);

test('?queue= replays every queue event in seq order as a queue-event, then follows an appended one, and never ends while the client stays', async () => {
  const { s, server } = seeded();
  const socket = connect(server, `queue=beta/${QUEUE_WORKFLOW}`);
  expect(await until(() => queueEvents(socket).length === 9)).toBe(true);
  expect(socket.messages[0]).toEqual({
    kind: 'queue-event',
    event: {
      seq: 1,
      ts: '2026-09-24T10:54:59.000Z',
      type: 'watch:added',
      workflow: QUEUE_WORKFLOW,
      pid: 4242,
      label: 'sail',
      everyMs: 300_000,
      maxConcurrentRuns: 2,
    },
  });
  const polled = { seq: 10, ts: '2026-09-24T11:06:00.000Z', type: 'queue:polled', workflow: QUEUE_WORKFLOW };
  appendFileSync(
    join(queueDirOf(s), 'events.ndjson'),
    `${JSON.stringify({ ...polled, kind: 'ticket', label: 'sail', found: 4, added: 0, durationMs: 90 })}\n`,
  );
  expect(await until(() => queueEvents(socket).length === 10)).toBe(true);
  // Ten poll intervals more: still open, and nothing but queue events.
  await Bun.sleep(200);
  expect(queueEvents(socket)).toEqual(range(1, 10));
  expect(socket.messages.map((message) => message.kind)).toEqual(Array(10).fill('queue-event'));
  expect(socket.closed).toBeUndefined();
  socket.close();
  expect(await until(() => socket.closed !== undefined)).toBe(true);
}, 15_000);

test('a queue stream whose line cannot be read sends an error naming it, then a close with 1011', async () => {
  const { s, server } = seeded();
  appendFileSync(join(queueDirOf(s), 'events.ndjson'), '{"seq": 10, "type": \n');
  const socket = connect(server, `queue=beta/${QUEUE_WORKFLOW}`);
  expect(await until(() => socket.closed !== undefined)).toBe(true);
  expect(socket.messages.at(-1)).toEqual({ kind: 'error', message: expect.stringContaining('events.ndjson:10') });
  expect(socket.closed).toBe(1011);
}, 15_000);

test.each([
  ['an unknown workflow', 'queue=beta/missing', "no queue 'missing' in beta"],
  ['an unknown repository', `queue=nobody/${QUEUE_WORKFLOW}`, `no repository for 'nobody/${QUEUE_WORKFLOW}'`],
  ['a workflow of ..', 'queue=beta/..', "no queue '..' in beta"],
  ['an encoded ..', 'queue=beta/%2e%2e', "no queue '..' in beta"],
  ['a workflow with a separator', `queue=beta/${QUEUE_WORKFLOW}/..`, `no queue '${QUEUE_WORKFLOW}/..' in beta`],
  ['a value with no repository', `queue=${QUEUE_WORKFLOW}`, `no repository for '${QUEUE_WORKFLOW}'`],
  ['a repository with no queue', `queue=alpha/${QUEUE_WORKFLOW}`, `no queue '${QUEUE_WORKFLOW}' in alpha`],
] as const)(
  'a queue WebSocket on %s is refused with 404 before the upgrade',
  async (_, query, error) => {
    const { server } = seeded();
    const response = await fetch(`http://127.0.0.1:${server.port}/ws?${query}`, { headers: { ...UPGRADE, ...HEADER } });
    expect([response.status, await response.json()]).toEqual([404, { error }]);
  },
  15_000,
);

test("the index carries each repository's queues, and an item added to queue.json sends a new index within two polls", async () => {
  const { s, server } = seeded();
  const socket = connect(server, 'index=1');
  expect(await until(() => socket.messages.length > 0)).toBe(true);
  const file = JSON.parse(readFileSync(join(queueDirOf(s), 'queue.json'), 'utf8'));
  const queuesOf = (message: Received) => message.repos.map((repo: Received) => [repo.name, repo.queues]);
  expect(queuesOf(socket.messages[0])).toEqual([
    ['alpha', []],
    ['beta', [{ workflow: QUEUE_WORKFLOW, queue: file }]],
  ]);
  const item = { ...file.items[0], dedupKey: 'ticket:FAKE-7', source: { kind: 'ticket', ticketKey: 'FAKE-7' } };
  writeFileSync(join(queueDirOf(s), 'queue.json'), JSON.stringify({ ...file, items: [...file.items, item] }));
  // Two polls of 30 ms, with room for a loaded machine.
  expect(await until(() => socket.messages.length > 1, 1000)).toBe(true);
  expect(socket.messages.at(-1).repos[1].queues[0].queue.items.map((entry: Received) => entry.dedupKey)).toEqual([
    'ticket:FAKE-5',
    'ticket:FAKE-3',
    'ticket:FAKE-6',
    'ticket:FAKE-4',
    'ticket:FAKE-7',
  ]);
}, 15_000);
