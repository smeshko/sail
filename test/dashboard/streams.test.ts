// The dashboard's WebSockets: `?run=` replays a run's events and follows it until it ends, `?index=1` sends every
// repository's runs and again when they change, and `?queue=` is reserved. Targets are refused over HTTP before any
// upgrade, and an upgrade needs this dashboard as its Origin, or the client header. Every wait polls for its condition
// against a deadline, so a broken stream fails an assertion rather than hanging.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Dashboard, startDashboard } from '../../src/dashboard/server';
import { openRunStream } from '../../src/dashboard/streams';
import { eventLines, GOLDEN_RUN_ID, type Machine, machine, treeHash } from '../helpers/dashboard';
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

function start(): Dashboard {
  const started = startDashboard({ registryDir: m.registryDir, port: 0, followPollMs: 20, indexPollMs: 30 });
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
  ['a queue', 'queue=alpha/ticket-to-pr', 404],
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
    if (query.startsWith('queue')) expect(body.error).toContain('Epic 13');
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
