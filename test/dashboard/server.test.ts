// The dashboard's server over HTTP: bound to 127.0.0.1, GET only, the client header and the Host check on every
// request, no CORS, and the REST routes over two registered clones that each hold a copy of the golden run. Every
// server starts on port 0 and is stopped after its test.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { takeLease } from '../../src/adapters/leases';
import { type Dashboard, guard, startDashboard } from '../../src/dashboard/server';
import { isRunIdOf } from '../../src/engine/run-id';
import {
  appendStageEnd,
  entryOf,
  FAKE_2_ID,
  FAKE_3_ID,
  fake2Dir,
  fakeClonePorts,
  GOLDEN_RUN,
  GOLDEN_RUN_ID,
  type Machine,
  machine,
  QUEUE_WORKFLOW,
  queueDirOf,
  SECRET,
  seedFixtures,
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
  const describe = await get(server, `${RUN}/calls/publish%231%2Fdescribe/log?stream=session`);
  expect([describe.status, describe.body]).toEqual([200, golden('05-publish/call-1/steps/1-describe/session.log')]);
  const open = await get(server, `${RUN}/calls/publish%231%2Fopen/log?stream=stdout`);
  expect([open.status, open.body]).toEqual([200, golden('05-publish/call-1/steps/2-open/stdout.log')]);
  expect(treeHash(m.root)).toBe(before);
});

test("a run's file by its path in the run: as text, or with as=html as its markdown's HTML; a bad path or as is 400", async () => {
  const server = start();
  const before = treeHash(m.root);
  const text = await get(server, `${RUN}/file?path=${encodeURIComponent('01-spec/call-1/out/spec.md')}`);
  expect([text.status, text.type, text.body]).toEqual([
    200,
    'text/plain; charset=utf-8',
    golden('01-spec/call-1/out/spec.md'),
  ]);
  const rendered = await get(server, `${RUN}/file?path=01-spec/call-1/out/spec.md&as=html`);
  expect([rendered.status, rendered.type]).toEqual([200, 'text/html; charset=utf-8']);
  expect(rendered.body).toStartWith('<h1>');
  expect((await get(server, `${RUN}/file`)).status).toBe(400);
  expect((await get(server, `${RUN}/file?path=01-spec/call-1/out/spec.md&as=pdf`)).status).toBe(400);
  expect((await get(server, `${RUN}/file?path=01-spec/call-1/none.md`)).status).toBe(404);
  expect((await get(server, `${RUN}/file?path=01-spec/call-1/none.md&as=html`)).status).toBe(404);
  expect(treeHash(m.root)).toBe(before);
});

test("a repository's queues: beta's one view, whose queue is its queue.json, and alpha's none, and reading changes nothing", async () => {
  const seeded = seedFixtures();
  try {
    const started = startDashboard({ registryDir: seeded.registryDir, port: 0 });
    if ('refused' in started) throw new Error(started.refused);
    servers.push(started);
    const before = treeHash(seeded.root);
    const beta = await get(started, '/api/repos/beta/queues');
    const file = JSON.parse(readFileSync(join(queueDirOf(seeded), 'queue.json'), 'utf8'));
    expect([beta.status, beta.type, JSON.parse(beta.body)]).toEqual([
      200,
      'application/json;charset=utf-8',
      [{ workflow: QUEUE_WORKFLOW, queue: file }],
    ]);
    const alpha = await get(started, '/api/repos/alpha/queues');
    expect([alpha.status, JSON.parse(alpha.body)]).toEqual([200, []]);
    expect(treeHash(seeded.root)).toBe(before);
  } finally {
    seeded.remove();
  }
});

test("a run's actions route answers what the run offers as JSON, 404 for an unknown run, and reads without writing", async () => {
  const seeded = seedFixtures();
  try {
    const leasesDir = join(seeded.root, 'leases');
    mkdirSync(leasesDir);
    const started = startDashboard({
      registryDir: seeded.registryDir,
      port: 0,
      leasesDir,
      ports: fakeClonePorts(leasesDir),
      env: { ...process.env, SAIL_HOME: seeded.sailHome },
    });
    if ('refused' in started) throw new Error(started.refused);
    servers.push(started);
    const before = treeHash(seeded.root);
    const failed = await get(started, `/api/repos/alpha/runs/${FAKE_2_ID}/actions`);
    const suspended = await get(started, `/api/repos/beta/runs/${FAKE_3_ID}/actions`);
    expect(JSON.parse(suspended.body).stop).toEqual({ enabled: true });
    const unknown = await get(started, '/api/repos/alpha/runs/FAKE-0-NOPE/actions');
    expect([failed.status, failed.type, JSON.parse(failed.body)]).toEqual([
      200,
      'application/json;charset=utf-8',
      {
        restart: {
          enabled: true,
          stages: [
            { stage: 'spec', runsAgain: 'spec#1 and everything after it' },
            { stage: 'implement', runsAgain: 'implement#1 and everything after it, in loop fix from iteration 1' },
          ],
          stage: 'implement',
          budget: { maxUsd: 25, maxMinutes: 90 },
        },
        clean: {
          enabled: true,
          removes: ['run ref'],
          archive: expect.stringMatching(new RegExp(`/failed-runs/\\d{4}-\\d{2}-\\d{2}/${FAKE_2_ID}$`)),
        },
      },
    ]);
    expect(unknown.status).toBe(404);
    expect(treeHash(seeded.root)).toBe(before);
  } finally {
    seeded.remove();
  }
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
  ['a file path that climbs out of the run', `${RUN}/file?path=..%2F..%2F..%2Foutside%2Fsecret.txt`, () => {}],
  [
    'a file path that climbs out of the run, as html',
    `${RUN}/file?path=..%2F..%2F..%2Foutside%2Fsecret.txt&as=html`,
    () => {},
  ],
  [
    'a run file that links out of the run, as html',
    `${RUN}/file?path=01-spec/call-1/out/spec.md&as=html`,
    (m: Machine) => {
      const spec = join(m.alpha.runDir, '01-spec/call-1/out/spec.md');
      rmSync(spec);
      symlinkSync(join(m.outside, 'secret.txt'), spec);
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

test('a call log that is a FIFO or a directory gets 404 at once, and a huge one is streamed, not read whole (review #1.5)', async () => {
  const call = join(m.alpha.runDir, '03-tests/call-1');
  rmSync(join(call, 'stdout.log'));
  Bun.spawnSync(['mkfifo', join(call, 'stdout.log')]);
  // Unblocks a server that opened the FIFO, so a broken check fails an assertion rather than hanging the test.
  const writer = Bun.spawn(['sh', '-c', `sleep 2; printf leaked > '${join(call, 'stdout.log')}'`]);
  try {
    const server = start();
    const began = Date.now();
    const fifo = await get(server, `${RUN}/calls/tests%231/log?stream=stdout`);
    expect([fifo.status, Date.now() - began < 1500]).toEqual([404, true]);
    expect((await get(server, '/api/repos')).status).toBe(200);
    rmSync(join(call, 'stderr.log'));
    mkdirSync(join(call, 'stderr.log'));
    const directory = await get(server, `${RUN}/calls/tests%231/log?stream=stderr`);
    expect([directory.status, JSON.parse(directory.body)]).toEqual([404, { error: expect.any(String) }]);
    truncateSync(join(m.alpha.runDir, 'events.ndjson'), 3 * 1024 ** 3);
    const huge = await fetch(`http://127.0.0.1:${server.port}${RUN}/events`, { headers: HEADER });
    expect([huge.status, huge.headers.get('content-length')]).toEqual([200, String(3 * 1024 ** 3)]);
    await huge.body?.cancel();
  } finally {
    writer.kill();
  }
});

test('a read that throws answers JSON 500, not an HTML page with a stack (review #1.6)', async () => {
  const server = start();
  renameSync(m.registryDir, `${m.registryDir}-moved`);
  writeFileSync(m.registryDir, 'not a directory\n');
  const failed = await get(server, '/api/repos');
  expect([failed.status, failed.type]).toEqual([500, 'application/json;charset=utf-8']);
  expect(JSON.parse(failed.body)).toEqual({ error: expect.any(String) });
});

test('GET / answers the page with no client header, a foreign Host gets 403 and a POST 405, /api still needs the header, and nothing changes on disk', async () => {
  const server = start();
  const before = treeHash(m.root);
  const page = await fetch(`http://127.0.0.1:${server.port}/`);
  expect([page.status, page.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8']);
  expect(page.headers.get('content-security-policy')).toContain(
    `connect-src http://127.0.0.1:${server.port} ws://127.0.0.1:${server.port}`,
  );
  expect(await page.text()).toContain('<title>sail dashboard</title>');
  const local = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { Host: `localhost:${server.port}` } });
  expect(local.headers.get('content-security-policy')).toContain(
    `connect-src http://localhost:${server.port} ws://localhost:${server.port}`,
  );
  expect((await get(server, '/', { headers: { Host: `evil.example:${server.port}` } })).status).toBe(403);
  const posted = await fetch(`http://127.0.0.1:${server.port}/`, { method: 'POST' });
  expect([posted.status, posted.headers.get('allow')]).toEqual([405, 'GET']);
  expect((await get(server, '/api/repos', { headers: {} })).status).toBe(403);
  expect((await get(server, '/index.html', { headers: {} })).status).toBe(403);
  expect(treeHash(m.root)).toBe(before);
}, 30_000);

const MOVE = '/api/repos/beta/queues/ticket-to-pr/move';
const JSON_HEADERS = { ...HEADER, 'Content-Type': 'application/json' };

/**
 * beta's queue: FAKE-5, FAKE-7 and FAKE-8 queued, FAKE-3 dispatched. With `watcher`, a live watcher in beta's `.sail/`
 * (or `sailDir`) that watches the workflow unless `watched` is false. Gives the queue file, and the inbox's files.
 */
function betaQueue(watcher: boolean, { watched = true, sailDir = m.beta.sailDir } = {}) {
  const runs = join(m.beta.clone, '.sail-runs');
  const dir = join(runs, 'queue', 'ticket-to-pr');
  mkdirSync(dir, { recursive: true });
  const item = (key: string, state: string) => ({
    dedupKey: `ticket:${key}`,
    source: { kind: 'ticket', ticketKey: key },
    title: `Ticket ${key}`,
    url: `fake://tickets/${key}`,
    state,
    attempts: 0,
    addedAt: '2026-10-14T09:00:00.000Z',
  });
  const file = join(dir, 'queue.json');
  writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      workflow: 'ticket-to-pr',
      updatedAt: '2026-10-14T09:00:00.000Z',
      polling: { label: 'sail', failures: 0 },
      items: [
        item('FAKE-3', 'dispatched'),
        item('FAKE-5', 'queued'),
        item('FAKE-7', 'queued'),
        item('FAKE-8', 'queued'),
      ],
    })}\n`,
  );
  const live = {
    pid: process.pid,
    startedAt: '2026-10-14T09:00:00.000Z',
    sailDir,
    ticketSource: 'fake',
    labels: ['sail'],
  };
  const event = (seq: number, type: string) =>
    `${JSON.stringify({ seq, ts: '2026-10-14T09:00:00.000Z', type, workflow: 'ticket-to-pr', pid: process.pid, label: 'sail', everyMs: 300000, maxConcurrentRuns: 2 })}\n`;
  writeFileSync(
    join(dir, 'events.ndjson'),
    watcher ? `${event(1, 'watch:added')}${watched ? '' : event(2, 'watch:removed')}` : '',
  );
  writeFileSync(
    join(m.registryDir, 'beta.json'),
    `${JSON.stringify({ ...entryOf(m.beta), ...(watcher ? { watcher: live } : {}) })}\n`,
  );
  const inboxDir = join(runs, 'watcher', 'commands');
  return { file, inboxDir, inbox: () => (existsSync(inboxDir) ? readdirSync(inboxDir) : []) };
}

const post = (server: Dashboard, path: string, init: RequestInit) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST', ...init });

test('a POST to a queue move route with the client header, a JSON body and no foreign Origin drops exactly that move command for the live watcher, and writes no queue state', async () => {
  const queue = betaQueue(true);
  const before = readFileSync(queue.file, 'utf8');
  const server = start();
  const body = { dedupKey: 'ticket:FAKE-7', before: 'ticket:FAKE-5' };
  const response = await post(server, MOVE, {
    headers: { ...JSON_HEADERS, Origin: `http://127.0.0.1:${server.port}` },
    body: JSON.stringify(body),
  });
  const answer = (await response.json()) as { file: string };
  const files = queue.inbox();
  expect({
    status: response.status,
    cors: response.headers.get('access-control-allow-origin'),
    files: files.length,
    answered: answer.file === join(queue.inboxDir, files[0] ?? ''),
    command: JSON.parse(readFileSync(join(queue.inboxDir, files[0] ?? ''), 'utf8')),
    queue: readFileSync(queue.file, 'utf8') === before,
  }).toEqual({
    status: 202,
    cors: null,
    files: 1,
    answered: true,
    command: { op: 'move', workflow: 'ticket-to-pr', ...body },
    queue: true,
  });
});

test('a POST of a move after its target drops a move command naming after, not before (review R6)', async () => {
  const queue = betaQueue(true);
  const server = start();
  const body = { dedupKey: 'ticket:FAKE-5', after: 'ticket:FAKE-7' };
  const response = await post(server, MOVE, { headers: JSON_HEADERS, body: JSON.stringify(body) });
  const files = queue.inbox();
  expect({
    status: response.status,
    command: JSON.parse(readFileSync(join(queue.inboxDir, files[0] ?? ''), 'utf8')),
  }).toEqual({ status: 202, command: { op: 'move', workflow: 'ticket-to-pr', ...body } });
});

test.each([
  ['no client header', MOVE, { headers: { 'Content-Type': 'application/json' } }, 403],
  ['a text/plain body', MOVE, { headers: { ...HEADER, 'Content-Type': 'text/plain' } }, 415],
  ['no content type', MOVE, { headers: HEADER }, 415],
  ['a foreign Origin', MOVE, { headers: { ...JSON_HEADERS, Origin: 'http://evil.example' } }, 403],
  ['another path', '/api/repos/beta/runs', { headers: JSON_HEADERS }, 405],
  ['the move route of a longer path', `${MOVE}/x`, { headers: JSON_HEADERS }, 405],
  ['an unregistered repository', '/api/repos/gamma/queues/ticket-to-pr/move', { headers: JSON_HEADERS }, 404],
  ['a workflow with no queue', '/api/repos/beta/queues/other/move', { headers: JSON_HEADERS }, 404],
] as const)('a POST with %s is refused with %i, and drops no command', async (_, path, init, status) => {
  const queue = betaQueue(true);
  const server = start();
  const body = JSON.stringify({ dedupKey: 'ticket:FAKE-7', before: 'ticket:FAKE-5' });
  const response = await post(server, path, { ...init, body });
  expect([response.status, response.headers.get('access-control-allow-origin'), queue.inbox()]).toEqual([
    status,
    null,
    [],
  ]);
});

test('an OPTIONS to the move route is 405 with Allow: GET, and drops no command', async () => {
  const queue = betaQueue(true);
  const server = start();
  const response = await fetch(`http://127.0.0.1:${server.port}${MOVE}`, { method: 'OPTIONS', headers: JSON_HEADERS });
  expect([response.status, response.headers.get('allow'), queue.inbox()]).toEqual([405, 'GET', []]);
});

const moveBody = (fields: Record<string, unknown>) => JSON.stringify({ dedupKey: 'ticket:FAKE-7', ...fields });

test.each([
  ['a body that is not JSON', 'not json', 400],
  ['neither before nor after', moveBody({}), 400],
  ['both before and after', moveBody({ before: 'ticket:FAKE-5', after: 'ticket:FAKE-8' }), 400],
  ['a field it does not take', moveBody({ before: 'ticket:FAKE-5', force: true }), 400],
  ['an item that is dispatched', moveBody({ dedupKey: 'ticket:FAKE-3', before: 'ticket:FAKE-5' }), 409],
  ['a target that is dispatched', moveBody({ after: 'ticket:FAKE-3' }), 409],
  ['an item the queue lacks', moveBody({ dedupKey: 'ticket:FAKE-9', before: 'ticket:FAKE-5' }), 409],
  ['the item as its own target', moveBody({ before: 'ticket:FAKE-7' }), 409],
] as const)('a move with %s is refused with %i as JSON, and drops no command', async (_, body, status) => {
  const queue = betaQueue(true);
  const server = start();
  const response = await post(server, MOVE, { headers: JSON_HEADERS, body });
  expect([response.status, queue.inbox()]).toEqual([status, []]);
  expect(await response.json()).toEqual({ error: expect.any(String) });
});

test('a move for a repository with no live watcher is 409 naming sail watch, and drops no command', async () => {
  const queue = betaQueue(false);
  const server = start();
  const response = await post(server, MOVE, {
    headers: JSON_HEADERS,
    body: moveBody({ before: 'ticket:FAKE-5' }),
  });
  expect([response.status, await response.json(), queue.inbox()]).toEqual([
    409,
    { error: "no watcher is running for 'beta': sail watch ticket-to-pr first" },
    [],
  ]);
});

test('a move for a workflow the live watcher no longer watches is 409 naming sail watch, and drops no command (review R1)', async () => {
  const queue = betaQueue(true, { watched: false });
  const server = start();
  const response = await post(server, MOVE, {
    headers: JSON_HEADERS,
    body: moveBody({ before: 'ticket:FAKE-5' }),
  });
  expect([response.status, await response.json(), queue.inbox()]).toEqual([
    409,
    {
      error: `the watcher of 'beta' (pid ${process.pid}) does not watch 'ticket-to-pr': sail watch ticket-to-pr first`,
    },
    [],
  ]);
});

test('a move for a repository whose live watcher runs in another clone is 409 naming it, and drops no command (review R1)', async () => {
  const queue = betaQueue(true, { sailDir: m.alpha.sailDir });
  const server = start();
  const response = await post(server, MOVE, {
    headers: JSON_HEADERS,
    body: moveBody({ before: 'ticket:FAKE-5' }),
  });
  expect([response.status, await response.json(), queue.inbox()]).toEqual([
    409,
    { error: `the watcher of 'beta' (pid ${process.pid}) runs in another clone: ${m.alpha.sailDir}` },
    [],
  ]);
});

const RESUME = `/api/repos/beta/runs/${FAKE_3_ID}/resume`;
const RESTART = `/api/repos/alpha/runs/${FAKE_2_ID}/restart`;
const startedBy = (body: string) => ({ headers: JSON_HEADERS, body });

/** A stand-in `sail` that records its arguments and then runs `script`, with the clone as its working directory. */
function stubSail(script: string): { cli: string[]; argv: () => string[] } {
  const file = join(m.root, 'stub-sail.sh');
  const record = join(m.root, 'stub-argv');
  writeFileSync(file, `#!/bin/sh\necho "$*" >> '${record}'\n${script}\n`);
  chmodSync(file, 0o755);
  return {
    cli: ['/bin/sh', file],
    argv: () => (existsSync(record) ? readFileSync(record, 'utf8').trimEnd().split('\n') : []),
  };
}

function startWith(cli: string[], startWaitMs = 5000): Dashboard {
  const leasesDir = join(m.root, 'leases');
  mkdirSync(leasesDir, { recursive: true });
  const started = startDashboard({
    registryDir: m.registryDir,
    port: 0,
    cli,
    leasesDir,
    env: process.env,
    startWaitMs,
  });
  if ('refused' in started) throw new Error(started.refused);
  servers.push(started);
  return started;
}

const settleQueue = () => {
  const file = join(queueDirOf(m), 'queue.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"state": "dispatched"', '"state": "done"'));
};
const betaRun = () => join(m.beta.clone, '.sail-runs', FAKE_3_ID);
const dashboardLogs = (clone: { clone: string }) => {
  const dir = join(clone.clone, '.sail-runs', 'dashboard');
  return existsSync(dir) ? readdirSync(dir) : [];
};

test('a POST to resume a suspended run starts `sail resume` with the raise, answers 202 once it is no longer suspended, and logs under .sail-runs/dashboard', async () => {
  m = seedFixtures();
  settleQueue();
  const stub = stubSail(`echo "started from $(pwd -P)"\nprintf 'running\\n' > '${join(betaRun(), 'STATUS')}'\nsleep 1`);
  const server = startWith(stub.cli);
  const response = await post(server, RESUME, startedBy('{"raise":{"usd":5}}'));
  expect([response.status, await response.json()]).toEqual([202, { runId: FAKE_3_ID }]);
  expect(stub.argv()).toEqual([`resume ${FAKE_3_ID} --raise-budget 5`]);
  expect(dashboardLogs(m.beta)).toEqual([`${FAKE_3_ID}.log`]);
  expect(readFileSync(join(m.beta.clone, '.sail-runs', 'dashboard', `${FAKE_3_ID}.log`), 'utf8')).toContain(
    `started from ${realpathSync(m.beta.clone)}`,
  );
  const runs = await get(server, '/api/repos/beta/runs');
  expect(JSON.parse(runs.body).map((run: { runId: string }) => run.runId)).not.toContain(`${FAKE_3_ID}.log`);
});

test('a POST to restart a failed run starts `sail run --from-run` under a minted id of its ticket and answers 202 with it once run.json exists', async () => {
  m = seedFixtures();
  const stub = stubSail(
    `id=$(echo "$*" | sed 's/.*--run-id //')\nmkdir -p ".sail-runs/$id"\necho '{}' > ".sail-runs/$id/run.json"\nsleep 1`,
  );
  const server = startWith(stub.cli);
  const response = await post(server, RESTART, startedBy('{"stage":"spec"}'));
  const { runId } = (await response.json()) as { runId: string };
  expect(response.status).toBe(202);
  expect(isRunIdOf('FAKE-2', runId)).toBe(true);
  expect(stub.argv()).toEqual([`run --from-run ${FAKE_2_ID} --stage spec --continue --run-id ${runId}`]);
  expect(dashboardLogs(m.alpha)).toEqual([`${runId}.log`]);
});

test('a start the sail refuses with exit code 3 is 409 with the last line it printed', async () => {
  m = seedFixtures();
  settleQueue();
  const stub = stubSail("echo 'one'\necho 'run is not suspended: nothing to resume' >&2\nexit 3");
  const server = startWith(stub.cli);
  const response = await post(server, RESUME, startedBy('{"raise":{"usd":5}}'));
  expect([response.status, await response.json()]).toEqual([409, { error: 'run is not suspended: nothing to resume' }]);
});

test.each([
  ['an internal error', 'exit 4', 'sail: the worktree could not be made'],
  ['a signal', 'kill -9 $$', 'sail: killed before it opened'],
])(
  'a start that ends on %s before the run has started is 409 with the last line it printed (review R8)',
  async (_, end, line) => {
    m = seedFixtures();
    settleQueue();
    const server = startWith(stubSail(`echo '${line}' >&2\n${end}`).cli);
    const response = await post(server, RESUME, startedBy('{"raise":{"usd":5}}'));
    expect([response.status, await response.json()]).toEqual([409, { error: line }]);
  },
);

test('a start still going when the wait ends is answered 202 anyway', async () => {
  m = seedFixtures();
  settleQueue();
  const stub = stubSail('sleep 2');
  const server = startWith(stub.cli, 300);
  const response = await post(server, RESUME, startedBy('{"raise":{"usd":5}}'));
  expect([response.status, await response.json()]).toEqual([202, { runId: FAKE_3_ID }]);
});

test('an action the run does not offer is 409 with the reason, and the sail never runs', async () => {
  m = seedFixtures();
  const stub = stubSail('exit 0');
  const server = startWith(stub.cli);
  const resume = await post(server, RESUME, startedBy('{"raise":{"usd":5}}'));
  expect([resume.status, await resume.json()]).toEqual([
    409,
    { error: "ticket-to-pr's watcher has this run: ticket:FAKE-3 is dispatched" },
  ]);
  const restart = await post(server, `/api/repos/beta/runs/${FAKE_3_ID}/restart`, startedBy('{"stage":"spec"}'));
  expect(restart.status).toBe(409);
  expect(stub.argv()).toEqual([]);
});

test('a second start of a run while the first is under way is 409, and only one sail runs', async () => {
  m = seedFixtures();
  settleQueue();
  const stub = stubSail(`sleep 1\nprintf 'running\\n' > '${join(betaRun(), 'STATUS')}'`);
  const server = startWith(stub.cli);
  const first = post(server, RESUME, startedBy('{"raise":{"usd":5}}'));
  await Bun.sleep(300);
  const second = await post(server, RESUME, startedBy('{"raise":{"usd":5}}'));
  expect([second.status, await second.json()]).toEqual([
    409,
    { error: `a start of ${FAKE_3_ID} is already under way` },
  ]);
  expect((await first).status).toBe(202);
  expect(stub.argv()).toEqual([`resume ${FAKE_3_ID} --raise-budget 5`]);
});

test.each([
  ['a resume with no raise for a run over its dollars', RESUME, '{}'],
  ['a resume raising the minutes it did not run out of', RESUME, '{"raise":{"minutes":5}}'],
  ['a resume raising less than a cent', RESUME, '{"raise":{"usd":0}}'],
  ['a resume with a field it does not take', RESUME, '{"raise":{"usd":5},"force":true}'],
  ['a resume that is not JSON', RESUME, 'nope'],
  ['a restart from a stage the run did not offer', RESTART, '{"stage":"publish"}'],
  ['a restart with no stage', RESTART, '{}'],
  ['a restart with a field it does not take', RESTART, '{"stage":"spec","x":1}'],
])('%s is 400 as JSON, and the sail never runs', async (_, path, body) => {
  m = seedFixtures();
  settleQueue();
  const stub = stubSail('exit 0');
  const server = startWith(stub.cli);
  const response = await post(server, path, startedBy(body));
  expect([response.status, await response.json()]).toEqual([400, { error: expect.any(String) }]);
  expect(stub.argv()).toEqual([]);
});

test('a start for a run the repository lacks is 404', async () => {
  m = seedFixtures();
  const server = startWith(stubSail('exit 0').cli);
  expect((await post(server, '/api/repos/alpha/runs/FAKE-0-NOPE/resume', startedBy('{}'))).status).toBe(404);
  expect((await post(server, '/api/repos/gamma/runs/FAKE-0-NOPE/restart', startedBy('{}'))).status).toBe(404);
});

test.each([
  ['no client header', { 'Content-Type': 'application/json' }, 403],
  ['a form content type', { ...HEADER, 'Content-Type': 'text/plain' }, 415],
  ['a foreign Origin', { ...JSON_HEADERS, Origin: 'http://evil.example' }, 403],
])('a start with %s is refused with %i, and the sail never runs', async (_, headers, status) => {
  m = seedFixtures();
  settleQueue();
  const stub = stubSail('exit 0');
  const server = startWith(stub.cli);
  for (const path of [RESUME, RESTART]) {
    const response = await post(server, path, { headers, body: '{"raise":{"usd":5},"stage":"spec"}' });
    expect(response.status).toBe(status);
  }
  const options = await fetch(`http://127.0.0.1:${server.port}${RESUME}`, { method: 'OPTIONS', headers: HEADER });
  expect([options.status, options.headers.get('allow')]).toEqual([405, 'GET']);
  expect(stub.argv()).toEqual([]);
});

const STOP = `/api/repos/beta/runs/${FAKE_3_ID}/stop`;
const CLEAN = `/api/repos/alpha/runs/${FAKE_2_ID}/clean`;
const FAKE_3_BRANCH = 'sail/FAKE-3-escape-b-this-b-that';
const FAKE_2_BRANCH = 'sail/FAKE-2-print-the-version-with-version';

/** A dashboard whose clones' ports are the fake workspace on a leases directory of the test's machine. */
function startPorts(more: Parameters<typeof fakeClonePorts>[1] = {}): Dashboard {
  const leasesDir = join(m.root, 'leases');
  mkdirSync(leasesDir, { recursive: true });
  const started = startDashboard({
    registryDir: m.registryDir,
    port: 0,
    leasesDir,
    ports: fakeClonePorts(leasesDir, more),
    env: { ...process.env, SAIL_HOME: m.sailHome },
  });
  if ('refused' in started) throw new Error(started.refused);
  servers.push(started);
  return started;
}

const control = () => readFileSync(join(betaRun(), 'CONTROL'), 'utf8').trim();
const statusOf = (dir: string) => readFileSync(join(dir, 'STATUS'), 'utf8').trim();

test('a POST to stop a run another process runs asks it to stop at its next call boundary, or at once with now, and answers 202 with the CLI words', async () => {
  m = seedFixtures();
  settleQueue();
  writeFileSync(join(betaRun(), 'STATUS'), 'running\n');
  const leasesDir = join(m.root, 'leases');
  mkdirSync(leasesDir, { recursive: true });
  const held = takeLease(leasesDir, 'fake://origin', FAKE_3_BRANCH, {
    runId: FAKE_3_ID,
    runDir: betaRun(),
    pid: process.ppid,
  });
  expect(held.leased).toBe(true);
  const server = startPorts();
  const later = await post(server, STOP, startedBy('{"now":false}'));
  expect([later.status, await later.json()]).toEqual([
    202,
    { message: `run ${FAKE_3_ID} stops at its next call boundary (pid ${process.ppid})` },
  ]);
  expect(control()).toBe('stopped');
  const now = await post(server, STOP, startedBy('{"now":true}'));
  expect([now.status, await now.json()]).toEqual([
    202,
    { message: `run ${FAKE_3_ID} ends its running call now (pid ${process.ppid})` },
  ]);
  expect(control()).toBe('stopped now');
  expect(statusOf(betaRun())).toBe('running');
});

test('a POST to stop a suspended run ends it failed, stopped, with run:end in its events', async () => {
  m = seedFixtures();
  settleQueue();
  const server = startPorts();
  const stopped = await post(server, STOP, startedBy('{"now":false}'));
  expect([stopped.status, await stopped.json()]).toEqual([202, { message: `run ${FAKE_3_ID} stopped` }]);
  expect(statusOf(betaRun())).toBe('failed stopped');
  expect(readFileSync(join(betaRun(), 'events.ndjson'), 'utf8')).toContain('"type":"run:end"');
});

test('a POST to stop a run that has ended is 409 with the engine words', async () => {
  m = seedFixtures();
  const server = startPorts();
  const ended = await post(server, `/api/repos/alpha/runs/${FAKE_2_ID}/stop`, startedBy('{"now":false}'));
  expect([ended.status, await ended.json()]).toEqual([
    409,
    { error: `run ${FAKE_2_ID} has ended (failed stage_error): there is nothing to stop` },
  ]);
});

test('the actions route offers Stop for a dispatched run still starting, with no run directory yet (review R2)', async () => {
  m = seedFixtures();
  const startingId = 'FAKE-5-01M3BWNZM08Q4T6V2XRJ5KWD9Z';
  const file = join(queueDirOf(m), 'queue.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace(`"runId": "${FAKE_3_ID}"`, `"runId": "${startingId}"`));
  const server = startPorts();
  const offers = await get(server, `/api/repos/beta/runs/${startingId}/actions`);
  expect([offers.status, JSON.parse(offers.body)]).toEqual([200, { stop: { enabled: true } }]);
  expect((await get(server, '/api/repos/beta/runs/FAKE-0-NOPE/actions')).status).toBe(404);
});

test('a POST to stop a run the repository lacks is 409 with the engine words, and a repository it lacks 404', async () => {
  m = seedFixtures();
  const server = startPorts();
  const lacking = await post(server, '/api/repos/alpha/runs/FAKE-0-NOPE/stop', startedBy('{"now":false}'));
  expect([lacking.status, await lacking.json()]).toEqual([409, { error: "no run 'FAKE-0-NOPE' in .sail-runs" }]);
  expect((await post(server, '/api/repos/gamma/runs/FAKE-0-NOPE/stop', startedBy('{"now":false}'))).status).toBe(404);
});

test('a POST to clean a failed run removes what the engine plans, archives its run directory, and answers 200 with the CLI line', async () => {
  m = seedFixtures();
  const calls: string[] = [];
  const server = startPorts({ calls, branches: { local: true, remote: false } });
  const cleaned = await post(server, CLEAN, startedBy('{}'));
  const answer = (await cleaned.json()) as { message: string; removed: string[]; archived: string };
  expect(cleaned.status).toBe(200);
  expect(answer.removed).toEqual([`branch ${FAKE_2_BRANCH}`, 'run ref']);
  expect(answer.archived).toMatch(new RegExp(`/failed-runs/\\d{4}-\\d{2}-\\d{2}/${FAKE_2_ID}$`));
  expect(answer.message).toBe(
    `cleaned ${FAKE_2_ID}: branch ${FAKE_2_BRANCH}, run ref; run directory -> ${answer.archived}`,
  );
  expect(calls).toEqual([
    `removeBranch ${FAKE_2_BRANCH} local`,
    `removeBranch ${FAKE_2_BRANCH} remote`,
    `removeRunRef ${FAKE_2_ID}`,
  ]);
  expect(existsSync(fake2Dir(m))).toBe(false);
  expect(existsSync(answer.archived)).toBe(true);
});

test('a POST to clean that the engine refuses is 409 with its words, and removes nothing: a leased branch and a run not failed', async () => {
  m = seedFixtures();
  const calls: string[] = [];
  const leasesDir = join(m.root, 'leases');
  mkdirSync(leasesDir, { recursive: true });
  const server = startPorts({ calls });
  const notFailed = await post(server, `/api/repos/beta/runs/${FAKE_3_ID}/clean`, startedBy('{}'));
  expect(notFailed.status).toBe(409);
  expect(((await notFailed.json()) as { error: string }).error).toContain(FAKE_3_ID);

  takeLease(leasesDir, 'fake://origin', FAKE_2_BRANCH, {
    runId: 'FAKE-9-01HZX3Y4Z5A6B7C8D9E0F1G2H3',
    runDir: m.root,
    pid: process.pid,
  });
  const leased = await post(server, CLEAN, startedBy('{}'));
  expect(leased.status).toBe(409);
  expect(((await leased.json()) as { error: string }).error).toContain('FAKE-9-01HZX3Y4Z5A6B7C8D9E0F1G2H3');

  expect(calls).toEqual([]);
  expect(existsSync(fake2Dir(m))).toBe(true);
});

test('a POST to clean a failed run whose branch has an open pull request is 409, and removes nothing', async () => {
  m = seedFixtures();
  const calls: string[] = [];
  const server = startPorts({
    calls,
    branches: { local: false, remote: true },
    codeHost: { pullRequestFrom: async () => ({ number: 7, url: 'fake://pr/7' }) } as never,
  });
  const pr = await post(server, CLEAN, startedBy('{}'));
  expect(pr.status).toBe(409);
  expect(((await pr.json()) as { error: string }).error).toContain('pull request');
  expect(calls).toEqual([]);
  expect(existsSync(fake2Dir(m))).toBe(true);
});

test('a POST to clean a failed run a queue item names is 409 with the engine words, and changes neither', async () => {
  m = seedFixtures();
  writeFileSync(join(betaRun(), 'STATUS'), 'failed workflow_failed\n');
  const queue = join(queueDirOf(m), 'queue.json');
  const text = readFileSync(queue, 'utf8');
  const server = startPorts();
  const refused = await post(server, `/api/repos/beta/runs/${FAKE_3_ID}/clean`, startedBy('{}'));
  expect([refused.status, await refused.json()]).toEqual([
    409,
    {
      error: `queue item ticket:FAKE-3 of ticket-to-pr (dispatched) names run ${FAKE_3_ID}: requeue it or drop it: \`sail queue requeue|drop\``,
    },
  ]);
  expect([readFileSync(queue, 'utf8'), existsSync(betaRun())]).toEqual([text, true]);
});

test.each([
  ['a stop with no now', STOP, '{}'],
  ['a stop with a now that is no boolean', STOP, '{"now":"yes"}'],
  ['a stop that is not JSON', STOP, 'nope'],
  ['a clean with a field it does not take', CLEAN, '{"x":1}'],
  ['a clean that is not JSON', CLEAN, 'nope'],
])('%s is 400 as JSON, and changes no run', async (_, path, body) => {
  m = seedFixtures();
  const server = startPorts();
  const before = treeHash(m.root);
  const response = await post(server, path, startedBy(body));
  expect([response.status, await response.json()]).toEqual([400, { error: expect.any(String) }]);
  expect(treeHash(m.root)).toBe(before);
});

test.each([
  ['no client header', { 'Content-Type': 'application/json' }, 403],
  ['a form content type', { ...HEADER, 'Content-Type': 'text/plain' }, 415],
  ['a foreign Origin', { ...JSON_HEADERS, Origin: 'http://evil.example' }, 403],
])('a stop or a clean with %s is refused with %i, and changes no run', async (_, headers, status) => {
  m = seedFixtures();
  const server = startPorts();
  const before = treeHash(m.root);
  for (const path of [STOP, CLEAN]) {
    const response = await post(server, path, { headers, body: '{"now":false}' });
    expect(response.status).toBe(status);
  }
  expect(treeHash(m.root)).toBe(before);
});
