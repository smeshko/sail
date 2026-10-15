// The watched workflows' queues as the dashboard reads them (D8): `.sail-runs/queue/<workflow>/queue.json`, read-only
// and contained as run files are. A workflow directory must have a plain name and lie inside `.sail-runs/`, and
// `queue.json` must be a regular file inside it, so no symlink leads out of the clone.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { index } from '../../src/dashboard/files';
import { findQueueDir, queueViews } from '../../src/dashboard/queues';
import {
  entryOf,
  type Machine,
  QUEUE_WORKFLOW,
  queueDirOf,
  SECRET,
  seedFixtures,
  treeHash,
} from '../helpers/dashboard';

let m: Machine;
beforeEach(() => {
  m = seedFixtures();
});
afterEach(() => m.remove());

const queueFile = () => JSON.parse(readFileSync(join(queueDirOf(m), 'queue.json'), 'utf8'));

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ("queueViews gives beta's one queue, equal to its queue.json, and alpha none, and reading changes nothing", () => {
  const before = treeHash(m.root);
  expect(queueViews(entryOf(m.beta))).toEqual([{ workflow: QUEUE_WORKFLOW, queue: queueFile() }]);
  expect(queueViews(entryOf(m.alpha))).toEqual([]);
  expect(findQueueDir(entryOf(m.beta), QUEUE_WORKFLOW)).toBe(queueDirOf(m));
  expect(treeHash(m.root)).toBe(before);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a queue.json that is not JSON or not a queue gives its workflow a problem and no queue, one not written yet gives the workflow alone, and the runs are still listed', () => {
  const queues = join(m.beta.clone, '.sail-runs', 'queue');
  for (const [workflow, text] of [
    ['broken', '{"version": 1,'],
    ['wrong', JSON.stringify({ ...queueFile(), version: 2 })],
  ] as const) {
    mkdirSync(join(queues, workflow));
    writeFileSync(join(queues, workflow, 'queue.json'), text);
  }
  mkdirSync(join(queues, 'fresh'));
  const views = queueViews(entryOf(m.beta));
  expect(views.map((view) => [view.workflow, view.queue === undefined, view.problem?.split(':')[0]])).toEqual([
    ['broken', true, "queue.json can't be read"],
    ['fresh', true, undefined],
    [QUEUE_WORKFLOW, false, undefined],
    ['wrong', true, 'queue.json is not a queue'],
  ]);
  expect(views[3]?.problem).toContain('/version');
  const beta = index(m.registryDir).find((repo) => repo.name === 'beta');
  expect([beta?.runs.length, beta?.problem, beta?.queues.length]).toEqual([1, undefined, 4]);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a queue/ linked out of .sail-runs/, a workflow directory linked out, a queue.json linked to a secret, and names that are not plain lead nowhere and read no byte from outside', () => {
  // Outside: a queue directory that looks real, for every link to aim at.
  const elsewhere = join(m.outside, 'queue', QUEUE_WORKFLOW);
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'queue.json'), JSON.stringify({ ...queueFile(), workflow: SECRET }));
  symlinkSync(join(m.outside, 'queue'), join(m.alpha.clone, '.sail-runs', 'queue'));
  symlinkSync(elsewhere, join(m.beta.clone, '.sail-runs', 'queue', 'linked'));
  const own = join(queueDirOf(m), 'queue.json');
  rmSync(own);
  symlinkSync(join(m.outside, 'secret.txt'), own);

  expect(queueViews(entryOf(m.alpha))).toEqual([]);
  const views = queueViews(entryOf(m.beta));
  expect(views).toEqual([
    { workflow: QUEUE_WORKFLOW, problem: 'queue.json is not a file of this queue, so nothing of it is read' },
  ]);
  expect(JSON.stringify(index(m.registryDir))).not.toContain(SECRET.slice(0, 13));
  for (const workflow of ['linked', '..', '%2e%2e', `${QUEUE_WORKFLOW}/..`, '.', 'missing', '']) {
    expect(findQueueDir(entryOf(m.beta), workflow)).toEqual({ missing: `no queue '${workflow}' in beta` });
  }
  expect(findQueueDir(entryOf(m.alpha), QUEUE_WORKFLOW)).toEqual({ missing: `no queue '${QUEUE_WORKFLOW}' in alpha` });
});
