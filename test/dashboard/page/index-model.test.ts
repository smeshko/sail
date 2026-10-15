// The rail's repositories and runs and the queue panel's model, from the index alone (D8, D9). The input is `index()`
// of the seeded fixtures: the very object the index stream sends, built server-side in the test.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { index } from '../../../src/dashboard/files';
import { queuePanels, railRepos, watchState } from '../../../src/dashboard/page/index-model';
import {
  FAKE_2_ID,
  FAKE_3_ID,
  GOLDEN_RUN_ID,
  type Machine,
  QUEUE_WORKFLOW,
  queueDirOf,
  RUNNING_ID,
  runningCopy,
  seedFixtures,
} from '../../helpers/dashboard';

let m: Machine;
beforeEach(() => {
  m = seedFixtures();
});
afterEach(() => m.remove());

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PAGE = join(import.meta.dir, '..', '..', '..', 'src', 'dashboard', 'page');
/** The names the fixtures give stages, workflows and repositories: no model may hold one. */
const NAMES = [
  'alpha',
  'beta',
  'ticket-to-pr',
  'spec',
  'implement',
  'tests',
  'self-review',
  'describe',
  'open',
  'lint',
];
const named = (file: string) => {
  const source = readFileSync(join(PAGE, file), 'utf8');
  return NAMES.filter((name) => new RegExp(`['"\`]${name}(['"\`#/:])`).test(source));
};

test('railRepos lists alpha then beta, each run newest first with its status, stop reason, duration and cost, and neither model names a fixture', () => {
  const repos = railRepos(index(m.registryDir), NOW);
  expect(repos.map((repo) => [repo.name, repo.remote, repo.live, repo.problem])).toEqual([
    ['alpha', 'https://example.com/alpha.git', false, undefined],
    ['beta', 'https://example.com/beta.git', false, undefined],
  ]);
  const rows = repos.flatMap((repo) =>
    repo.runs.map((run) => [
      repo.name,
      run.runId,
      run.ticketKey,
      run.status,
      run.stopReason,
      run.durationMs,
      run.costUsd,
    ]),
  );
  expect(rows).toEqual([
    ['alpha', GOLDEN_RUN_ID, 'FAKE-1', 'completed', undefined, 15_900, 1.35],
    ['alpha', FAKE_2_ID, 'FAKE-2', 'failed', 'stage_error', 4900, 0.3625],
    ['beta', FAKE_3_ID, 'FAKE-3', 'suspended', 'budget_exceeded', 6200, 1.0625],
  ]);
  expect(repos[1]?.runs[0]).toMatchObject({
    title: 'Escape <b>this</b> & "that"',
    workflow: 'ticket-to-pr@1',
    startedAt: '2026-09-24T11:00:00.000Z',
  });
  expect([...named('index-model.ts'), ...named('attention.ts')]).toEqual([]);
});

test('a running copy is live, listed first, and its duration is the time since it started', () => {
  runningCopy(m, 20);
  const started = Date.parse('2026-09-25T09:00:00.000Z');
  const [alpha] = railRepos(index(m.registryDir), started + 5000);
  expect([alpha?.live, alpha?.runs.map((run) => [run.runId, run.status, run.durationMs])]).toEqual([
    true,
    [
      [RUNNING_ID, 'running', 5000],
      [GOLDEN_RUN_ID, 'completed', 15_900],
      [FAKE_2_ID, 'failed', 4900],
    ],
  ]);
});

test("queuePanels gives beta's queue with its counts and its items by state, and nothing once beta's queue/ is gone", () => {
  const [panel, ...others] = queuePanels(index(m.registryDir));
  expect(others).toEqual([]);
  expect([panel?.repo, panel?.workflow, panel?.problem, panel?.queue?.polling.label]).toEqual([
    'beta',
    QUEUE_WORKFLOW,
    undefined,
    'sail',
  ]);
  expect(panel?.counts).toEqual({ queued: 1, dispatched: 1, failed: 0, parked: 1, done: 1 });
  expect(panel?.items.map((item) => [item.dedupKey, item.state, item.runListed])).toEqual([
    ['ticket:FAKE-5', 'queued', false],
    ['ticket:FAKE-3', 'dispatched', true],
    ['ticket:FAKE-6', 'parked', false],
    ['ticket:FAKE-4', 'done', false],
  ]);
  rmSync(join(m.beta.clone, '.sail-runs', 'queue'), { recursive: true });
  expect(queuePanels(index(m.registryDir))).toEqual([]);
});

test('watchState is watched after watch:added, not watched after a later watch:removed, and unknown with no watch event', () => {
  const events = readFileSync(join(queueDirOf(m), 'events.ndjson'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const removed = { seq: 10, ts: '2026-09-24T12:00:00.000Z', type: 'watch:removed', workflow: QUEUE_WORKFLOW };
  expect([
    watchState(events),
    watchState([...events, removed]),
    watchState([...events, removed, { ...removed, seq: 11, type: 'watch:added' }]),
    watchState(events.filter((event) => !event.type.startsWith('watch:'))),
  ]).toEqual(['watched', 'not watched', 'watched', 'unknown']);
});

test('a repository whose .sail/ is gone shows in the rail with its problem and no runs', () => {
  rmSync(m.alpha.sailDir, { recursive: true });
  const repos = railRepos(index(m.registryDir), NOW);
  expect(repos.map((repo) => [repo.name, repo.runs.length, typeof repo.problem])).toEqual([
    ['alpha', 0, 'string'],
    ['beta', 1, 'undefined'],
  ]);
  expect(repos[0]?.problem).toContain('no longer exists');
});
