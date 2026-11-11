// The dashboard's release of a usage-limit hold over HTTP: it records the release in the machine directory as
// `sail watch --release-hold` does, needs no watcher, and answers with the CLI's line.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Dashboard, startDashboard } from '../../src/dashboard/server';
import { holdsDir, readHold, releasedAt, writeHold } from '../../src/watch/holds';
import { entryOf, type Machine, machine } from '../helpers/dashboard';

let m: Machine;
const servers: Dashboard[] = [];
beforeEach(() => {
  m = machine();
  // A queue for beta, and a registry entry with no watcher.
  mkdirSync(join(m.beta.clone, '.sail-runs', 'queue', 'ticket-to-pr'), { recursive: true });
  writeFileSync(join(m.registryDir, 'beta.json'), `${JSON.stringify(entryOf(m.beta))}\n`);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  m.remove();
});

const JSON_HEADERS = { 'X-Sail-Dashboard': '1', 'Content-Type': 'application/json' };
const PATH = '/api/repos/beta/queues/ticket-to-pr/release';

function serve(): Dashboard {
  const started = startDashboard({ registryDir: m.registryDir, port: 0 });
  if ('refused' in started) throw new Error(started.refused);
  servers.push(started);
  return started;
}

const post = (server: Dashboard, body: unknown, path = PATH, headers: Record<string, string> = JSON_HEADERS) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const hold = {
  until: '2099-01-01T00:00:00.000Z',
  reason: 'claude-code hit the usage limit',
  runId: 'r',
  repository: 'beta',
};
const held = () => (existsSync(holdsDir(m.sailHome)) ? readdirSync(holdsDir(m.sailHome)).sort() : []);

test('a release removes the hold, records it and answers the CLI’s line, with no watcher running', async () => {
  writeHold(m.sailHome, 'claude-code', hold);
  const answer = await post(serve(), { harnessKey: 'claude-code' });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ message: 'released the usage-limit hold on claude-code' });
  expect(readHold(m.sailHome, 'claude-code')).toBeUndefined();
  expect(typeof releasedAt(m.sailHome, 'claude-code')).toBe('number');
});

test('a release of a key with no hold answers that none was there, and still records the release', async () => {
  const answer = await post(serve(), { harnessKey: 'claude-code' });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({
    message: 'no usage-limit hold on claude-code; its held runs resume on the next tick',
  });
  expect(typeof releasedAt(m.sailHome, 'claude-code')).toBe('number');
});

test('a key with a colon is released under its own files and another key’s hold stays', async () => {
  writeHold(m.sailHome, 'pi:openai-codex', hold);
  writeHold(m.sailHome, 'claude-code', hold);
  const answer = await post(serve(), { harnessKey: 'pi:openai-codex' });
  expect(await answer.json()).toEqual({ message: 'released the usage-limit hold on pi:openai-codex' });
  expect(readHold(m.sailHome, 'pi:openai-codex')).toBeUndefined();
  expect(releasedAt(m.sailHome, 'pi:openai-codex')).toBeDefined();
  expect(readHold(m.sailHome, 'claude-code')).toBeDefined();
  expect(releasedAt(m.sailHome, 'claude-code')).toBeUndefined();
});

test.each([
  ['an empty object', {}],
  ['an empty key', { harnessKey: '' }],
  ['an extra field', { harnessKey: 'x', extra: 1 }],
  ['a key over 100 characters', { harnessKey: 'k'.repeat(101) }],
])('%s is refused 400 as not a release and writes nothing', async (_name, body) => {
  const before = held();
  const answer = await post(serve(), body);
  expect(answer.status).toBe(400);
  expect(((await answer.json()) as { error: string }).error).toStartWith('not a release:');
  expect(held()).toEqual(before);
});

test('a body that is not JSON is refused 400 and writes nothing', async () => {
  const answer = await post(serve(), 'nope');
  expect(answer.status).toBe(400);
  expect(held()).toEqual([]);
});

test('an unknown repository and a workflow with no queue are 404 and write nothing', async () => {
  const server = serve();
  expect(
    (await post(server, { harnessKey: 'claude-code' }, '/api/repos/nowhere/queues/ticket-to-pr/release')).status,
  ).toBe(404);
  expect((await post(server, { harnessKey: 'claude-code' }, '/api/repos/beta/queues/missing/release')).status).toBe(
    404,
  );
  expect(held()).toEqual([]);
});

test('a POST without the client header is 403, without a JSON content type 415, an OPTIONS 405 and a GET no release; none writes', async () => {
  const server = serve();
  const body = JSON.stringify({ harnessKey: 'claude-code' });
  expect((await post(server, body, PATH, { 'Content-Type': 'application/json' })).status).toBe(403);
  expect((await post(server, body, PATH, { 'X-Sail-Dashboard': '1', 'Content-Type': 'text/plain' })).status).toBe(415);
  expect((await fetch(`${server.url}${PATH}`, { headers: { 'X-Sail-Dashboard': '1' } })).status).toBe(404);
  expect((await fetch(`${server.url}${PATH}`, { method: 'OPTIONS', headers: JSON_HEADERS })).status).toBe(405);
  expect(held()).toEqual([]);
});
