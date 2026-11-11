// What the server offers a queue, its items, a workflow and a repository (src/dashboard/offers.ts), in the `Offer`
// shape a run's actions have, and the one `watching()` check the queue POSTs share.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepo, index } from '../../src/dashboard/files';
import { offeredQueues, watching } from '../../src/dashboard/offers';
import { writeStatus } from '../../src/engine/run-dir';
import { type Machine, machine } from '../helpers/dashboard';

let m: Machine;
beforeEach(() => {
  m = machine();
});
afterEach(() => m.remove());

const WORKFLOW = 'ticket-to-pr';
const AT = '2026-10-14T09:00:00.000Z';
const NO_WATCHER = { enabled: false, why: "no watcher is running for 'beta': sail watch ticket-to-pr first" };

const item = (key: string, state: string, fields: Record<string, unknown> = {}) => ({
  dedupKey: `ticket:${key}`,
  source: { kind: 'ticket', ticketKey: key },
  title: key,
  url: `fake://tickets/${key}`,
  state,
  attempts: 0,
  addedAt: AT,
  ...fields,
});

/** beta's queue: one item of each state, a failed one on a running run and one on a run that has ended. */
function world(options: { watcher?: 'here' | 'elsewhere' | 'none'; watched?: boolean } = {}) {
  const { watcher = 'here', watched = true } = options;
  const runs = join(m.beta.clone, '.sail-runs');
  for (const [id, status] of [
    ['LIVE-RUN', 'running'],
    ['ENDED-RUN', 'completed'],
  ] as const) {
    mkdirSync(join(runs, id), { recursive: true });
    writeFileSync(join(runs, id, 'run.json'), '{}');
    writeStatus(join(runs, id), status);
  }
  const dir = join(runs, 'queue', WORKFLOW);
  mkdirSync(dir, { recursive: true });
  const items = [
    item('D', 'dispatched', { runId: 'LIVE-RUN' }),
    item('Q', 'queued'),
    item('P', 'parked'),
    item('FL', 'failed', { runId: 'LIVE-RUN' }),
    item('FE', 'failed', { runId: 'ENDED-RUN' }),
    item('DONE', 'done'),
  ];
  writeFileSync(
    join(dir, 'queue.json'),
    JSON.stringify({ version: 1, workflow: WORKFLOW, updatedAt: AT, polling: { label: 'sail', failures: 0 }, items }),
  );
  const event = (type: string) =>
    `${JSON.stringify({ seq: 1, ts: AT, type, workflow: WORKFLOW, pid: process.pid, label: 'sail', everyMs: 1, maxConcurrentRuns: 1 })}\n`;
  writeFileSync(join(dir, 'events.ndjson'), watcher !== 'none' && watched ? event('watch:added') : '');
  const sailDir = watcher === 'elsewhere' ? join(m.root, 'elsewhere', '.sail') : m.beta.sailDir;
  const live = { pid: process.pid, startedAt: AT, sailDir, ticketSource: 'fake', labels: ['sail'] };
  writeFileSync(
    join(m.registryDir, 'beta.json'),
    `${JSON.stringify({ ...entry(), ...(watcher === 'none' ? {} : { watcher: live }) })}\n`,
  );
}

const entry = () => {
  const found = findRepo(m.registryDir, 'beta');
  if (found === undefined) throw new Error('no beta');
  return found;
};
const beta = () => index(m.registryDir).find((repo) => repo.name === 'beta');
const offersOf = (key: string) => beta()?.queues[0]?.offers?.items[`ticket:${key}`];

test("a queue with no live watcher offers poll and add disabled, in the POST's own words", () => {
  world({ watcher: 'none' });
  const [queue] = offeredQueues(entry());
  expect(queue?.offers?.poll).toEqual(NO_WATCHER);
  expect(queue?.offers?.add).toEqual(NO_WATCHER);
  expect(queue?.offers?.items['ticket:Q']).toEqual({ drop: NO_WATCHER, move: NO_WATCHER });
  expect(watching(entry(), WORKFLOW)).toEqual({ refused: NO_WATCHER.why });
});

test('with a live watcher in the clone watching the workflow every queue offer is enabled', () => {
  world();
  const offers = offeredQueues(entry())[0]?.offers;
  expect(offers?.poll).toEqual({ enabled: true });
  expect(offers?.add).toEqual({ enabled: true });
  expect(offers?.items['ticket:Q']).toEqual({ drop: { enabled: true }, move: { enabled: true } });
  expect(watching(entry(), WORKFLOW)).toMatchObject({ label: 'sail' });
});

test('a watcher in another clone, or one that does not watch the workflow, gives watching() refusal as why', () => {
  world({ watcher: 'elsewhere' });
  const why = (watching(entry(), WORKFLOW) as { refused: string }).refused;
  expect(why).toBe(
    `the watcher of 'beta' (pid ${process.pid}) runs in another clone: ${join(m.root, 'elsewhere', '.sail')}`,
  );
  expect(offeredQueues(entry())[0]?.offers?.poll).toEqual({ enabled: false, why });
  world({ watched: false });
  const other = (watching(entry(), WORKFLOW) as { refused: string }).refused;
  expect(other).toBe(
    `the watcher of 'beta' (pid ${process.pid}) does not watch '${WORKFLOW}': sail watch ${WORKFLOW} first`,
  );
  expect(offeredQueues(entry())[0]?.offers?.add).toEqual({ enabled: false, why: other });
});

test('an item offers the actions of its state: a running one none, a failed one requeue only once its run has ended', () => {
  world();
  const on = { enabled: true };
  expect(offersOf('D')).toEqual({});
  expect(offersOf('Q')).toEqual({ drop: on, move: on });
  expect(offersOf('P')).toEqual({ requeue: on, drop: on });
  expect(offersOf('FL')).toEqual({ drop: on });
  expect(offersOf('FE')).toEqual({ requeue: on, drop: on });
  expect(offersOf('DONE')).toEqual({ drop: on });
});

test('the index gives a watched workflow unwatch and an unwatched one with a queue watch', () => {
  world();
  mkdirSync(join(m.beta.clone, '.sail-runs', 'queue', 'other'), { recursive: true });
  const offers = beta()?.offers;
  expect(offers?.workflows).toEqual({
    [WORKFLOW]: { unwatch: { enabled: true } },
    other: { watch: { enabled: true } },
  });
  expect(offers?.watch).toEqual({ enabled: true });
  expect(offers?.unwatch).toEqual({ enabled: true });
});

test('a repository with no watch set offers watch alone', () => {
  world({ watcher: 'none' });
  const offers = beta()?.offers;
  expect(offers?.unwatch).toBeUndefined();
  expect(offers?.workflows).toEqual({ [WORKFLOW]: { watch: { enabled: true } } });
});

test('a repository whose .sail/ is gone has watch disabled with its path', () => {
  world({ watcher: 'none' });
  rmSync(m.beta.sailDir, { recursive: true, force: true });
  expect(beta()?.offers?.watch).toEqual({ enabled: false, why: `${m.beta.sailDir} no longer exists` });
});

test('an item keyed __proto__ is read as an own key and pollutes nothing', () => {
  world();
  const queue = join(m.beta.clone, '.sail-runs', 'queue', WORKFLOW, 'queue.json');
  const file = JSON.parse(readFileSync(queue, 'utf8'));
  file.items.push({ ...item('X', 'queued'), dedupKey: '__proto__' });
  writeFileSync(queue, JSON.stringify(file));
  const items = beta()?.queues[0]?.offers?.items;
  expect(Object.hasOwn(items ?? {}, '__proto__')).toBe(true);
  expect(({} as Record<string, unknown>).drop).toBeUndefined();
});

/** `.sail/workflows/<name>/workflow.ts` for each name, and a config with `defaultWorkflow`. */
function workflows(names: string[], defaultWorkflow?: string): void {
  for (const name of names) {
    mkdirSync(join(m.beta.sailDir, 'workflows', name), { recursive: true });
    writeFileSync(join(m.beta.sailDir, 'workflows', name, 'workflow.ts'), '');
  }
  mkdirSync(join(m.beta.sailDir, 'workflows', 'no-file'), { recursive: true });
  const config = readFileSync(join(import.meta.dir, '..', 'fixtures', 'repo', '.sail', 'project.yaml'), 'utf8');
  writeFileSync(
    join(m.beta.sailDir, 'project.yaml'),
    defaultWorkflow === undefined ? config.replace(/^defaultWorkflow:.*\n/m, '') : config,
  );
}

test('a repository offers start with the workflows of .sail/workflows/ that hold a workflow.ts, and the config default', () => {
  workflows(['ticket-to-pr', 'review'], 'ticket-to-pr');
  expect(beta()?.offers?.start).toEqual({
    enabled: true,
    workflows: ['review', 'ticket-to-pr'],
    defaultWorkflow: 'ticket-to-pr',
  });
});

test('start leaves defaultWorkflow out when the config sets none or does not read', () => {
  workflows(['review']);
  expect(beta()?.offers?.start).toEqual({ enabled: true, workflows: ['review'] });
  writeFileSync(join(m.beta.sailDir, 'project.yaml'), 'not: [valid');
  expect(beta()?.offers?.start).toEqual({ enabled: true, workflows: ['review'] });
});

test('start is disabled with the path when .sail/ is gone', () => {
  rmSync(m.beta.sailDir, { recursive: true, force: true });
  expect(beta()?.offers?.start).toEqual({
    enabled: false,
    why: `${m.beta.sailDir} no longer exists`,
    workflows: [],
  });
});
