// The dashboard's check of a start over HTTP: `POST /api/repos/<repo>/starts/check` runs `sail <source> --workflow <name>
// --dry-run …` in the clone, through a stand-in `sail` that records its arguments, and answers what it printed. Every
// server starts on port 0 and is stopped after its test.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Dashboard, startDashboard } from '../../src/dashboard/server';
import { type Machine, seedFixtures } from '../helpers/dashboard';

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
const CHECK = '/api/repos/beta/starts/check';
const FIRST = 'ticket-to-pr@1 on FAKE-1: Add a --shout flag to the greet command (Todo)';
const DRY = 'dry run: nothing was written: no run directory, workspace, lease, claim or comment';

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

const check = (server: Dashboard, body: unknown, path = CHECK) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });

const answer = async (response: Response) => [response.status, await response.json()];

/** `text` as one shell word. */
const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

const SOURCE = { source: 'FAKE-1', workflow: 'ticket-to-pr', until: 'spec' };

test('a check of FAKE-1 runs `sail FAKE-1 --workflow ticket-to-pr --until spec --dry-run` in the clone and answers its roster, key and start', async () => {
  const stub = stubSail(`printf '%s\\n' ${quoted(FIRST)} ${quoted(DRY)}`);
  const server = startWith(stub.cli);
  expect(await answer(await check(server, SOURCE))).toEqual([
    200,
    { roster: `${FIRST}\n${DRY}`, key: 'FAKE-1', forced: [], start: SOURCE },
  ]);
  expect(stub.argv()).toEqual(['FAKE-1 --workflow ticket-to-pr --until spec --dry-run']);
});

test('a check names the checks the roster says were forced, and passes --force and --ignore-prerequisites on', async () => {
  const stub = stubSail(`printf '%s\\n' ${quoted(FIRST)} '  forced    designation, state' ${quoted(DRY)}`);
  const server = startWith(stub.cli);
  const body = { source: 'FAKE-1', force: true, ignorePrerequisites: true };
  const [status, json] = await answer(await check(server, body));
  expect([status, (json as { forced: string[] }).forced, (json as { start: unknown }).start]).toEqual([
    200,
    ['designation', 'state'],
    body,
  ]);
  expect(stub.argv()).toEqual(['FAKE-1 --force --ignore-prerequisites --dry-run']);
});

test('a pull request is checked under the key pr-<number>', async () => {
  const stub = stubSail(`printf '%s\\n' 'review@1 on #12: Fix it (open)' ${quoted(DRY)}`);
  const server = startWith(stub.cli);
  const [status, json] = await answer(await check(server, { source: '#12', workflow: 'review' }));
  expect([status, (json as { key: string }).key]).toEqual([200, 'pr-12']);
  expect(stub.argv()).toEqual(['#12 --workflow review --dry-run']);
});

test('a refusal --force overrides is 409 with the line sail printed and override force', async () => {
  const line = 'sail FAKE-3: FAKE-3 is not designated for sail. --force runs it anyway';
  const stub = stubSail(`echo ${quoted(line)} >&2\nexit 3`);
  const server = startWith(stub.cli);
  expect(await answer(await check(server, { source: 'FAKE-3' }))).toEqual([
    409,
    { error: line, override: 'force', start: { source: 'FAKE-3' } },
  ]);
});

test("a refusal --force doesn't change offers no start anyway", async () => {
  const line = "sail #4: pull request #4 is a draft. --force doesn't change that";
  const stub = stubSail(`echo ${quoted(line)} >&2\nexit 3`);
  const server = startWith(stub.cli);
  expect(await answer(await check(server, { source: '#4' }))).toEqual([409, { error: line, start: { source: '#4' } }]);
});

test('exit 5 offers --ignore-prerequisites', async () => {
  const line = 'sail FAKE-4: FAKE-4 waits on FAKE-1. --ignore-prerequisites runs it anyway';
  const stub = stubSail(`echo ${quoted(line)} >&2\nexit 5`);
  const server = startWith(stub.cli);
  expect(await answer(await check(server, { source: 'FAKE-4' }))).toEqual([
    409,
    { error: line, override: 'ignore-prerequisites', start: { source: 'FAKE-4' } },
  ]);
});

test('a dry run that names no source is 409 with its output', async () => {
  const stub = stubSail(`echo 'something else'`);
  const server = startWith(stub.cli);
  expect(await answer(await check(server, { source: 'FAKE-1' }))).toEqual([
    409,
    { error: "the dry run's output names no source: something else", start: { source: 'FAKE-1' } },
  ]);
});

test.each([
  ['a source that is an option', { source: '--dispatch' }, "'--dispatch' is no ticket key or pull request"],
  ['a workflow that is no plain name', { source: 'FAKE-1', workflow: '../x' }, "'../x' is no workflow name"],
  ['a stage that is no plain name', { source: 'FAKE-1', until: 'a b' }, "'a b' is no stage name"],
])('%s is 400 and starts no process', async (_name, body, message) => {
  const stub = stubSail('exit 0');
  const server = startWith(stub.cli);
  expect(await answer(await check(server, body))).toEqual([400, { error: message }]);
  expect(stub.argv()).toEqual([]);
});

test('a body with an unknown field is 400', async () => {
  const stub = stubSail('exit 0');
  const server = startWith(stub.cli);
  const [status] = await answer(await check(server, { source: 'FAKE-1', record: 'x' }));
  expect([status, stub.argv()]).toEqual([400, []]);
});

test('a repository that is not registered is 404', async () => {
  const server = startWith(stubSail('exit 0').cli);
  expect(await answer(await check(server, SOURCE, '/api/repos/nope/starts/check'))).toEqual([
    404,
    { error: "no repository 'nope'" },
  ]);
});

test('a second check of a repository while one is under way is 409', async () => {
  const stub = stubSail(`sleep 1\nprintf '%s\\n' ${quoted(FIRST)}`);
  const server = startWith(stub.cli);
  const first = check(server, { source: 'FAKE-1' });
  await Bun.sleep(300);
  expect(await answer(await check(server, { source: 'FAKE-2' }))).toEqual([
    409,
    { error: "a check of a start in 'beta' is already under way" },
  ]);
  expect((await first).status).toBe(200);
});

test('a check that outlasts startWaitMs is 202 waiting', async () => {
  const stub = stubSail('sleep 2');
  const server = startWith(stub.cli, 200);
  const [status, json] = await answer(await check(server, { source: 'FAKE-1' }));
  expect([status, Object.keys(json as object)]).toEqual([202, ['waiting']]);
});

test('the check route needs the client header (403) and a JSON content type (415), and a GET of it is not served', async () => {
  const server = startWith(stubSail('exit 0').cli);
  const url = `http://127.0.0.1:${server.port}${CHECK}`;
  const bare = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const text = await fetch(url, {
    method: 'POST',
    headers: { 'X-Sail-Dashboard': '1', 'Content-Type': 'text/plain' },
    body: '{}',
  });
  const got = await fetch(url, { headers: { 'X-Sail-Dashboard': '1' } });
  expect([bare.status, text.status, got.status]).toEqual([403, 415, 404]);
});
