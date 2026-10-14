// The dashboard's server over HTTP: bound to 127.0.0.1, GET only, the client header and the Host check on every
// request, no CORS, and the REST routes over two registered clones that each hold a copy of the golden run. Every
// server starts on port 0 and is stopped after its test.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { type Dashboard, guard, startDashboard } from '../../src/dashboard/server';
import {
  appendStageEnd,
  entryOf,
  GOLDEN_RUN,
  GOLDEN_RUN_ID,
  type Machine,
  machine,
  SECRET,
  treeHash,
} from '../helpers/dashboard';

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

/** A dashboard over the test's machine, on a free port, stopped after the test. */
function start(port = 0): Dashboard {
  const started = startDashboard({ registryDir: m.registryDir, port });
  if ('refused' in started) throw new Error(`the dashboard refused to start: ${started.refused}`);
  servers.push(started);
  return started;
}

/** `path` on `server`, with the client header unless `headers` replaces it. No answer may carry a CORS header. */
async function get(server: Dashboard, path: string, init: RequestInit = { headers: HEADER }) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, init);
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  return { status: response.status, type: response.headers.get('content-type'), body: await response.text() };
}

const golden = (path: string) => readFileSync(join(GOLDEN_RUN, path), 'utf8');
const RUN = `/api/repos/alpha/runs/${GOLDEN_RUN_ID}`;

/** The machine's first IPv4 address other than loopback, if it has one. */
const external = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === 'IPv4' && !address.internal)?.address;

/**
 * Whether a TCP connection to `host:port` opens within 3 s. A refusal is false, and so is silence: some networks drop
 * a connection to a port nothing listens on rather than refuse it.
 */
async function connects(host: string, port: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), 3000);
  });
  const attempt = Bun.connect({ hostname: host, port, socket: { data() {} } }).then(
    (socket) => {
      socket.end();
      return true;
    },
    () => false,
  );
  try {
    return await Promise.race([attempt, silence]);
  } finally {
    clearTimeout(timer);
  }
}

test("the server answers on 127.0.0.1 only: its url, and a connection to the machine's own address is refused", async () => {
  const server = start();
  expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
  expect((await get(server, '/api/repos')).status).toBe(200);
  if (external === undefined) return;
  expect(await connects(external, server.port)).toBe(false);
}, 10_000);

test("the repositories, each one's runs, and a run's summary and events, byte for byte, change nothing on disk", async () => {
  const server = start();
  const before = treeHash(m.root);
  const listed = await get(server, '/api/repos');
  expect(listed.type).toStartWith('application/json');
  expect(JSON.parse(listed.body)).toEqual({ repos: [entryOf(m.alpha), entryOf(m.beta)], problems: [] });
  for (const name of ['alpha', 'beta']) {
    const runs = JSON.parse((await get(server, `/api/repos/${name}/runs`)).body);
    expect(runs.map((run: { runId: string; summary: unknown }) => [run.runId, run.summary])).toEqual([
      [GOLDEN_RUN_ID, JSON.parse(golden('summary.json'))],
    ]);
  }
  const summary = await get(server, `${RUN}/summary`);
  expect([summary.status, summary.body]).toEqual([200, golden('summary.json')]);
  const events = await get(server, `/api/repos/beta/runs/${GOLDEN_RUN_ID}/events`);
  expect([events.status, events.type, events.body]).toEqual([200, 'application/x-ndjson', golden('events.ndjson')]);
  expect(treeHash(m.root)).toBe(before);
});

test("a call's result and logs: the stream asked for, else the session for an agent call and stdout for a script call", async () => {
  const server = start();
  const before = treeHash(m.root);
  const result = await get(server, `${RUN}/calls/implement%231/result`);
  expect([result.status, result.body]).toEqual([200, golden('02-implement/call-1/result.json')]);
  const stderr = await get(server, `${RUN}/calls/tests%231/log?stream=stderr`);
  expect([stderr.status, stderr.type, stderr.body]).toEqual([
    200,
    'text/plain; charset=utf-8',
    golden('03-tests/call-1/stderr.log'),
  ]);
  expect((await get(server, `${RUN}/calls/spec%231/log`)).body).toBe(golden('01-spec/call-1/session.log'));
  expect((await get(server, `${RUN}/calls/tests%232/log`)).body).toBe(golden('03-tests/call-2/stdout.log'));
  expect((await get(server, `${RUN}/calls/tests%231/log?stream=nope`)).status).toBe(400);
  expect(treeHash(m.root)).toBe(before);
});

test("a repository's queues are an empty list until the watcher", async () => {
  const server = start();
  const queues = await get(server, '/api/repos/alpha/queues');
  expect([queues.status, JSON.parse(queues.body)]).toEqual([200, []]);
});

test.each([
  ['no client header', {}],
  ['X-Sail-Dashboard: 0', { 'X-Sail-Dashboard': '0' }],
  ['X-Sail-Dashboard: true', { 'X-Sail-Dashboard': 'true' }],
  ['another Host, even with the header', { ...HEADER, Host: 'evil.example:80' }],
])('a request with %s gets 403', async (_, headers) => {
  const server = start();
  expect((await get(server, '/api/repos')).status).toBe(200);
  const refused = await get(server, '/api/repos', { headers: { ...headers } });
  expect(refused.status).toBe(403);
  expect(refused.body).not.toContain('alpha');
});

test("the Host check takes this server's own host and port only, by address or as localhost", () => {
  const at = (host: string) =>
    guard(new Request('http://127.0.0.1:4000/api/repos', { headers: { ...HEADER, Host: host } }), 4000)?.status;
  expect([at('127.0.0.1:4000'), at('localhost:4000')]).toEqual([undefined, undefined]);
  expect([at('127.0.0.1:4001'), at('localhost'), at('evil.example:4000'), at('127.0.0.1.evil.example:4000')]).toEqual([
    403, 403, 403, 403,
  ]);
});

test.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'])(
  '%s gets 405 with Allow: GET, with or without the header',
  async (method) => {
    const server = start();
    for (const headers of [HEADER, {}]) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/repos`, { method, headers });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect([response.status, response.headers.get('allow')]).toEqual([405, 'GET']);
    }
  },
);

test.each([
  ['an unregistered repository', '/api/repos/gamma/runs', () => {}],
  ['a run id with encoded separators', '/api/repos/alpha/runs/..%2F..%2F..%2Foutside/summary', () => {}],
  ['a run id of ..', '/api/repos/alpha/runs/%2E%2E/summary', () => {}],
  [
    'a call whose resultPath was edited to lead out',
    `${RUN}/calls/evil%231/result`,
    (m: Machine) => appendStageEnd(m.alpha.runDir, 'evil#1', join(m.outside, 'result.json')),
  ],
  [
    'a session.log that links out of the run',
    `${RUN}/calls/spec%231/log`,
    (m: Machine) => {
      const log = join(m.alpha.runDir, '01-spec/call-1/session.log');
      rmSync(log);
      symlinkSync(join(m.outside, 'session.log'), log);
    },
  ],
  [
    'a summary.json that links out of the run',
    `${RUN}/summary`,
    (m: Machine) => {
      rmSync(join(m.alpha.runDir, 'summary.json'));
      symlinkSync(join(m.outside, 'secret.txt'), join(m.alpha.runDir, 'summary.json'));
    },
  ],
] as const)('%s gets 404 and nothing of the file', async (_, path, tamper) => {
  tamper(m);
  const server = start();
  expect((await get(server, `/api/repos/beta/runs/${GOLDEN_RUN_ID}/summary`)).status).toBe(200);
  const refused = await get(server, path);
  expect(refused.status).toBe(404);
  expect(refused.body).not.toContain(SECRET.slice(0, 13));
  expect(JSON.parse(refused.body)).toEqual({ error: expect.any(String) });
});

test('a second dashboard on a port in use is refused, naming the port, and stop() frees it', async () => {
  const first = start();
  const second = startDashboard({ registryDir: m.registryDir, port: first.port });
  expect(second).toEqual({ refused: expect.stringContaining(String(first.port)) });
  await first.stop();
  servers = [];
  const third = start(first.port);
  expect(third.port).toBe(first.port);
  expect((await get(third, '/api/repos')).status).toBe(200);
});
