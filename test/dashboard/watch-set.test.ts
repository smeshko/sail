// The dashboard's watch and unwatch routes over HTTP: `POST /api/repos/<repo>/watch` and `…/unwatch` spawn `sail watch` or
// `sail unwatch` in the clone, through a stand-in `sail` that records its arguments, and answer with the CLI's own line.
// Every server starts on port 0 and is stopped after its test.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Dashboard, startDashboard } from '../../src/dashboard/server';
import { NOT_TAKEN } from '../../src/watch/inbox';
import { type Machine, QUEUE_WORKFLOW, queueDirOf, seedFixtures } from '../helpers/dashboard';

let m: Machine;
const servers: Dashboard[] = [];
beforeEach(() => {
  m = seedFixtures();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  m.remove();
});

const JSON_HEADERS = { 'X-Sail-Dashboard': '1', 'Content-Type': 'application/json' };
const WATCH = '/api/repos/beta/watch';
const UNWATCH = '/api/repos/beta/unwatch';
const names = (...workflows: string[]) => ({ headers: JSON_HEADERS, body: JSON.stringify({ workflows }) });

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
  const started = startDashboard({ registryDir: m.registryDir, port: 0, cli, env: process.env, startWaitMs });
  if ('refused' in started) throw new Error(started.refused);
  servers.push(started);
  return started;
}

const post = (server: Dashboard, path: string, init: RequestInit) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST', ...init });

/** `text` as one shell word. */
const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

const answer = async (response: Response) => [response.status, await response.json()];

const registryFile = () => join(m.registryDir, 'beta.json');
const eventsFile = () => join(queueDirOf(m), 'events.ndjson');

/** The JSON of beta's registry entry with a watcher (this process) in `sailDir`, or with none. */
function entryJson(watcherIn: string | undefined): string {
  const entry = {
    schema: 'sail.registry.v1',
    name: 'beta',
    remote: 'https://example.com/beta.git',
    clone: m.beta.clone,
    sailDir: m.beta.sailDir,
    updatedAt: '2026-10-14T09:00:00.000Z',
    ...(watcherIn === undefined
      ? {}
      : {
          watcher: {
            pid: process.pid,
            startedAt: '2026-10-14T09:00:00.000Z',
            sailDir: watcherIn,
            ticketSource: 'fake',
            labels: ['sail'],
          },
        }),
  };
  return JSON.stringify(entry);
}

const event = (type: string, seq: number) =>
  `${JSON.stringify({ seq, ts: '2026-10-14T09:00:00.000Z', type, workflow: QUEUE_WORKFLOW, pid: process.pid, label: 'sail', everyMs: 300000, maxConcurrentRuns: 2 })}\n`;

/** beta with a live watcher (this process) in `sailDir` that watches ticket-to-pr, or with none. */
function betaWatcher(live: boolean, sailDir = m.beta.sailDir) {
  writeFileSync(registryFile(), `${entryJson(live ? sailDir : undefined)}\n`);
  writeFileSync(eventsFile(), live ? event('watch:added', 1) : '');
}

const removedEvent = () => event('watch:removed', 2);
const clog = (name: string) => join(m.beta.clone, '.sail-runs', 'dashboard', name);
const WATCHES = `sail watch: the watcher of 'beta' (pid ${process.pid}) watches ticket-to-pr`;

test('a watch with no live watcher spawns `sail watch <names>` in the clone and answers 202 with the pid once the registry holds a live watcher in its .sail/, its output in watcher.log', async () => {
  betaWatcher(false);
  const stub = stubSail(
    `echo "watching from $(pwd -P)"\nprintf '%s\\n' '${entryJson(m.beta.sailDir)}' > '${registryFile()}'\nsleep 1`,
  );
  const server = startWith(stub.cli);
  const response = await post(server, WATCH, names('ticket-to-pr'));
  expect(await answer(response)).toEqual([
    202,
    {
      message: `the watcher of 'beta' (pid ${process.pid}) starts, its output in .sail-runs/dashboard/watcher.log`,
      pid: process.pid,
    },
  ]);
  expect(stub.argv()).toEqual(['watch ticket-to-pr']);
  expect(readFileSync(clog('watcher.log'), 'utf8')).toContain('watching from ');
  expect(existsSync(clog('watch-set.log'))).toBe(false);
});

test('a watch with no names spawns `sail watch` for every workflow', async () => {
  betaWatcher(false);
  const stub = stubSail(`printf '%s\\n' '${entryJson(m.beta.sailDir)}' > '${registryFile()}'\nsleep 1`);
  const server = startWith(stub.cli);
  expect((await post(server, WATCH, names())).status).toBe(202);
  expect(stub.argv()).toEqual(['watch']);
});

test('a watcher the registry holds in another clone does not count as started: the watch waits and answers 202 { waiting } at the deadline', async () => {
  betaWatcher(false);
  const stub = stubSail(`printf '%s\\n' '${entryJson(m.alpha.sailDir)}' > '${registryFile()}'\nsleep 2`);
  const server = startWith(stub.cli, 400);
  const response = await post(server, WATCH, names('ticket-to-pr'));
  expect(await answer(response)).toEqual([
    202,
    {
      waiting: "the watcher of 'beta' is still starting: its output is in .sail-runs/dashboard/watcher.log",
    },
  ]);
});

test.each([
  ['no workflow declares a watch', 'sail watch: no workflow declares a watch'],
  ['a workflow that declares no watch', "sail watch: workflow 'review' declares no watch"],
  ['two workflows on one label', "sail watch: workflows 'a' and 'b' both poll the label 'sail'"],
  ['a watcher in another clone', 'sail watch: the watcher of beta runs in another clone'],
  ['a model alias its harness cannot run', "sail watch: model alias 'default' names a model its harness can't run"],
])('a watcher that refuses to start on %s is 409 with the line it printed', async (_, line) => {
  betaWatcher(false);
  const stub = stubSail(`echo 'one'\necho ${quoted(line)} >&2\nexit 3`);
  const server = startWith(stub.cli);
  const response = await post(server, WATCH, names('review'));
  expect(await answer(response)).toEqual([409, { error: line }]);
});

test('a watch with a live watcher spawns `sail watch <names>`, logs to watch-set.log, and answers 200 with the CLI line and the live set', async () => {
  betaWatcher(true);
  const stub = stubSail(`echo ${quoted(WATCHES)}`);
  const server = startWith(stub.cli);
  const response = await post(server, WATCH, names('ticket-to-pr'));
  expect(await answer(response)).toEqual([200, { message: WATCHES, workflows: ['ticket-to-pr'] }]);
  expect(stub.argv()).toEqual(['watch ticket-to-pr']);
  expect(readFileSync(clog('watch-set.log'), 'utf8')).toBe(`${WATCHES}\n`);
  expect(existsSync(clog('watcher.log'))).toBe(false);
});

test('an unwatch of every workflow spawns `sail unwatch`, and answers 200 with the empty-set line and workflows: []', async () => {
  betaWatcher(true);
  const line = `sail unwatch: the watch set is empty: the watcher of 'beta' (pid ${process.pid}) stops`;
  const stub = stubSail(`printf '%s' '${removedEvent()}' >> '${eventsFile()}'\necho ${quoted(line)}`);
  const server = startWith(stub.cli);
  const response = await post(server, UNWATCH, names());
  expect(await answer(response)).toEqual([200, { message: line, workflows: [] }]);
  expect(stub.argv()).toEqual(['unwatch']);
  expect(readFileSync(clog('watch-set.log'), 'utf8')).toBe(`${line}\n`);
});

test('an unwatch of some workflows names them to the CLI', async () => {
  betaWatcher(true);
  const stub = stubSail(`echo ${quoted(WATCHES)}`);
  const server = startWith(stub.cli);
  const response = await post(server, UNWATCH, names('ticket-to-pr-b', 'review'));
  expect(response.status).toBe(200);
  expect(stub.argv()).toEqual(['unwatch ticket-to-pr-b review']);
});

test('a command the watcher has not taken is 202 { waiting } with the CLI line', async () => {
  betaWatcher(true);
  const line = `sail watch: the watcher of 'beta' (pid ${process.pid}) ${NOT_TAKEN}: it waits in .sail-runs/watcher/commands/x.json`;
  const server = startWith(stubSail(`echo ${quoted(line)}`).cli);
  const response = await post(server, WATCH, names('ticket-to-pr'));
  expect(await answer(response)).toEqual([202, { waiting: line }]);
});

test('a change still running when the wait ends is 202 { waiting }', async () => {
  betaWatcher(true);
  const server = startWith(stubSail('sleep 2').cli, 300);
  const response = await post(server, WATCH, names('ticket-to-pr'));
  expect(await answer(response)).toEqual([
    202,
    {
      waiting:
        "the change of the watch set of 'beta' is still under way: its output is in .sail-runs/dashboard/watch-set.log",
    },
  ]);
});

test('an unwatch with no live watcher passes the CLI refusal through as 409', async () => {
  betaWatcher(false);
  const line = "sail unwatch: no watcher is running for 'beta' here: nothing to unwatch";
  const stub = stubSail(`echo ${quoted(line)} >&2\nexit 3`);
  const server = startWith(stub.cli);
  const response = await post(server, UNWATCH, names());
  expect(await answer(response)).toEqual([409, { error: line }]);
  expect(stub.argv()).toEqual(['unwatch']);
});

test('a refusal of a change to a live watcher is 409 with the CLI line', async () => {
  betaWatcher(true);
  const line = "sail watch: workflow 'review' declares no watch";
  const server = startWith(stubSail(`echo ${quoted(line)} >&2\nexit 3`).cli);
  const response = await post(server, WATCH, names('review'));
  expect(await answer(response)).toEqual([409, { error: line }]);
});

test('a change that ends on another code with nothing printed is 409 naming the command and the code', async () => {
  betaWatcher(true);
  const server = startWith(stubSail('exit 4').cli);
  const response = await post(server, WATCH, names('ticket-to-pr'));
  expect(await answer(response)).toEqual([409, { error: 'sail watch exited 4' }]);
});

test('a second change to a repository while one is under way is 409, and only one sail runs', async () => {
  betaWatcher(true);
  const stub = stubSail(`sleep 1\necho ${quoted(WATCHES)}`);
  const server = startWith(stub.cli);
  const first = post(server, WATCH, names('ticket-to-pr'));
  await Bun.sleep(300);
  const second = await post(server, UNWATCH, names('ticket-to-pr'));
  expect(await answer(second)).toEqual([409, { error: "a watch-set change of 'beta' is already under way" }]);
  expect((await first).status).toBe(200);
  expect(stub.argv()).toEqual(['watch ticket-to-pr']);
});

test.each([
  ['no client header', { 'Content-Type': 'application/json' }, 403],
  ['a form content type', { 'X-Sail-Dashboard': '1', 'Content-Type': 'text/plain' }, 415],
  ['a foreign Origin', { ...JSON_HEADERS, Origin: 'http://evil.example' }, 403],
])('a watch or unwatch with %s is refused with %i, and the sail never runs', async (_, headers, status) => {
  betaWatcher(true);
  const stub = stubSail('exit 0');
  const server = startWith(stub.cli);
  for (const path of [WATCH, UNWATCH]) {
    const response = await post(server, path, { headers, body: '{"workflows":[]}' });
    expect(response.status).toBe(status);
  }
  expect(stub.argv()).toEqual([]);
});

test.each([
  ['a body that is not JSON', 'nope'],
  ['no workflows', '{}'],
  ['workflows that are not a list', '{"workflows":"review"}'],
  ['a workflow that is not a string', '{"workflows":[1]}'],
  ['an empty name', '{"workflows":[""]}'],
  ['a field it does not take', '{"workflows":[],"force":true}'],
  ['a name with a slash', '{"workflows":["a/b"]}'],
  ['a name that climbs', '{"workflows":[".."]}'],
])('a watch with %s is 400 as JSON, and the sail never runs', async (_, body) => {
  betaWatcher(true);
  const stub = stubSail('exit 0');
  const server = startWith(stub.cli);
  const response = await post(server, WATCH, { headers: JSON_HEADERS, body });
  expect([response.status, await response.json()]).toEqual([400, { error: expect.any(String) }]);
  expect(stub.argv()).toEqual([]);
});

test('a watch of a repository the registry lacks is 404, and a repository whose .sail/ is gone is 409', async () => {
  betaWatcher(true);
  const stub = stubSail('exit 0');
  const server = startWith(stub.cli);
  expect((await post(server, '/api/repos/gamma/watch', names())).status).toBe(404);
  writeFileSync(registryFile(), `${entryJson(undefined).replace(m.beta.sailDir, join(m.beta.clone, '.gone'))}\n`);
  const gone = await post(server, WATCH, names());
  expect(await answer(gone)).toEqual([409, { error: `${join(m.beta.clone, '.gone')} no longer exists` }]);
  expect(stub.argv()).toEqual([]);
});

test('another method on a watch route is 405 with Allow: GET, and the sail never runs', async () => {
  betaWatcher(true);
  const stub = stubSail('exit 0');
  const server = startWith(stub.cli);
  for (const method of ['PUT', 'DELETE', 'OPTIONS']) {
    const response = await fetch(`http://127.0.0.1:${server.port}${WATCH}`, { method, headers: JSON_HEADERS });
    expect([response.status, response.headers.get('allow')]).toEqual([405, 'GET']);
  }
  const longer = await post(server, `${WATCH}/x`, names());
  expect(longer.status).toBe(405);
  expect(stub.argv()).toEqual([]);
});
