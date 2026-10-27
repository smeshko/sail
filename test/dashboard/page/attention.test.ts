// Needs attention, from the index alone (D9): failed and suspended runs, calls that ended in error or were denied,
// parked queue items and problems, across every repository in one list, each saying what it opens.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { index } from '../../../src/dashboard/files';
import { attention } from '../../../src/dashboard/page/attention';
import {
  FAKE_2_ID,
  FAKE_3_ID,
  GOLDEN_RUN_ID,
  type Machine,
  QUEUE_WORKFLOW,
  seedFixtures,
} from '../../helpers/dashboard';

let m: Machine;
beforeEach(() => {
  m = seedFixtures();
});
afterEach(() => m.remove());

const FAKE_2_MESSAGE = 'implement#1 ended in error: harness: the session ended before it submitted a result';
const PARKED = 'stage_error: implement#1 ended in error: harness: the session ended before it submitted a result';

test("attention lists, across both repositories, FAKE-2's failure, error and denial, FAKE-3's suspension and error, and FAKE-6 parked, and nothing of the golden run", () => {
  const items = attention(index(m.registryDir));
  expect(items).toEqual([
    {
      repo: 'alpha',
      runId: FAKE_2_ID,
      kind: 'failed',
      title: 'failed: stage_error',
      detail: `FAKE-2 Print the version with --version · ${FAKE_2_MESSAGE}`,
      opens: { repo: 'alpha', runId: FAKE_2_ID },
    },
    {
      repo: 'alpha',
      runId: FAKE_2_ID,
      key: 'implement#1',
      kind: 'error',
      title: 'implement#1 ended in error',
      detail: '',
      opens: { repo: 'alpha', runId: FAKE_2_ID, key: 'implement#1' },
    },
    {
      repo: 'alpha',
      runId: FAKE_2_ID,
      kind: 'denial',
      title: '1 denial',
      detail: 'implement#1: 1',
      opens: { repo: 'alpha', runId: FAKE_2_ID, key: 'implement#1', tab: 'permissions' },
    },
    {
      repo: 'beta',
      runId: FAKE_3_ID,
      kind: 'suspended',
      title: 'suspended: budget_exceeded',
      detail: `sail resume ${FAKE_3_ID}`,
      opens: { repo: 'beta', runId: FAKE_3_ID },
    },
    {
      repo: 'beta',
      runId: FAKE_3_ID,
      key: 'implement#1',
      kind: 'error',
      title: 'implement#1 ended in error',
      detail: '',
      opens: { repo: 'beta', runId: FAKE_3_ID, key: 'implement#1' },
    },
    {
      repo: 'beta',
      workflow: QUEUE_WORKFLOW,
      kind: 'parked',
      title: 'ticket:FAKE-6 parked after 2 attempts',
      detail: PARKED,
    },
  ]);
  expect(items.some((item) => item.runId === GOLDEN_RUN_ID)).toBe(false);
});

test("a run's denials across several calls are one item: their total, each call's count in order, opening the first", () => {
  const repos = index(m.registryDir);
  const run = repos.find((repo) => repo.name === 'alpha')?.runs.find((each) => each.runId === FAKE_2_ID);
  const calls = run?.summary?.calls ?? [];
  expect(calls.map((call) => [call.key, call.denials])).toEqual([
    ['intake#1', undefined],
    ['spec#1', 0],
    ['implement#1', 1],
  ]);
  for (const call of calls) if (call.key === 'spec#1') call.denials = 4;
  expect(attention(repos).filter((item) => item.kind === 'denial')).toEqual([
    {
      repo: 'alpha',
      runId: FAKE_2_ID,
      kind: 'denial',
      title: '5 denials',
      detail: 'spec#1: 4 · implement#1: 1',
      opens: { repo: 'alpha', runId: FAKE_2_ID, key: 'spec#1', tab: 'permissions' },
    },
  ]);
});

test('a failed run without a message keeps the ticket as its detail, and a suspended one with a message puts it before the resume command', () => {
  const repos = index(m.registryDir);
  const runOf = (repo: string, id: string) => repos.find((r) => r.name === repo)?.runs.find((r) => r.runId === id);
  const failed = runOf('alpha', FAKE_2_ID)?.summary;
  const suspended = runOf('beta', FAKE_3_ID)?.summary;
  if (failed) Reflect.deleteProperty(failed, 'message');
  if (suspended) suspended.message = 'the run budget is spent';
  const details = attention(repos)
    .filter((item) => item.kind === 'failed' || item.kind === 'suspended')
    .map((item) => item.detail);
  expect(details).toEqual([
    'FAKE-2 Print the version with --version',
    `the run budget is spent · sail resume ${FAKE_3_ID}`,
  ]);
});

test("without beta's queue/ the parked item is gone, and the rest stays", () => {
  rmSync(join(m.beta.clone, '.sail-runs', 'queue'), { recursive: true });
  expect(attention(index(m.registryDir)).map((item) => `${item.repo} ${item.kind}`)).toEqual([
    'alpha failed',
    'alpha error',
    'alpha denial',
    'beta suspended',
    'beta error',
  ]);
});

test('a repository whose .sail/ is gone is a problem, after what else it needs, and opens nothing', () => {
  rmSync(m.beta.sailDir, { recursive: true });
  const beta = attention(index(m.registryDir)).filter((item) => item.repo === 'beta');
  expect(beta.map((item) => [item.kind, item.title, item.opens])).toEqual([['problem', 'repository', undefined]]);
  expect(beta[0]?.detail).toContain('no longer exists');
});
