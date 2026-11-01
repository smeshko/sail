// Needs attention, from the index alone (D9): failed runs, calls that ended in error, parked queue items and
// problems, across every repository in one list, each saying what it opens.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { index } from '../../../src/dashboard/files';
import { type AttentionItem, attention, identity } from '../../../src/dashboard/page/attention';
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

test("a running run's stalled steps add no item", () => {
  const repos = index(m.registryDir);
  const run = repos[0]?.runs.find((run) => run.runId === GOLDEN_RUN_ID);
  if (!run?.summary) throw new Error('missing fixture summary');
  run.summary.stalled = [
    { key: 'spec#1', since: '2026-10-01T12:00:00.000Z' },
    { key: 'publish#1/describe', since: '2026-10-01T12:01:00.000Z' },
  ];
  run.status = { status: 'running' };
  expect(attention(repos).filter((item) => item.runId === GOLDEN_RUN_ID)).toEqual([]);
});

const FAKE_2_MESSAGE = 'implement#1 ended in error: harness: the session ended before it submitted a result';
const PARKED = 'stage_error: implement#1 ended in error: harness: the session ended before it submitted a result';

test("attention lists, across both repositories, FAKE-2's failure and error, FAKE-3's error, and FAKE-6 parked, and nothing of the golden run", () => {
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

test('a run with denials adds no item', () => {
  const repos = index(m.registryDir);
  const run = repos.find((repo) => repo.name === 'alpha')?.runs.find((each) => each.runId === FAKE_2_ID);
  const calls = run?.summary?.calls ?? [];
  expect(calls.map((call) => [call.key, call.denials])).toEqual([
    ['intake#1', undefined],
    ['spec#1', 0],
    ['implement#1', 1],
  ]);
  for (const call of calls) if (call.key === 'spec#1') call.denials = 4;
  expect(attention(repos).map((item) => item.title)).not.toContain('5 denials');
  expect(attention(repos).map((item) => item.title)).not.toContain('1 denial');
});

test('a failed run without a message keeps the ticket as its detail', () => {
  const repos = index(m.registryDir);
  const failed = repos.find((r) => r.name === 'alpha')?.runs.find((r) => r.runId === FAKE_2_ID)?.summary;
  if (failed) Reflect.deleteProperty(failed, 'message');
  const details = attention(repos)
    .filter((item) => item.kind === 'failed')
    .map((item) => item.detail);
  expect(details).toEqual(['FAKE-2 Print the version with --version']);
});

test('a suspended run adds no item', () => {
  const repos = index(m.registryDir);
  const suspended = repos.find((r) => r.name === 'beta')?.runs.find((r) => r.runId === FAKE_3_ID);
  expect(suspended?.status?.status).toBe('suspended');
  expect(attention(repos).filter((item) => item.runId === FAKE_3_ID && item.key === undefined)).toEqual([]);
});

test('a failed run without a ticket has its message alone as its detail', () => {
  const repos = index(m.registryDir);
  const failed = repos.find((r) => r.name === 'alpha')?.runs.find((r) => r.runId === FAKE_2_ID)?.summary;
  if (failed) Reflect.deleteProperty(failed, 'ticket');
  const details = attention(repos)
    .filter((item) => item.kind === 'failed')
    .map((item) => item.detail);
  expect(details).toEqual([FAKE_2_MESSAGE]);
});

test("without beta's queue/ the parked item is gone, and the rest stays", () => {
  rmSync(join(m.beta.clone, '.sail-runs', 'queue'), { recursive: true });
  expect(attention(index(m.registryDir)).map((item) => `${item.repo} ${item.kind}`)).toEqual([
    'alpha failed',
    'alpha error',
    'beta error',
  ]);
});

test('a repository whose .sail/ is gone is a problem, after what else it needs, and opens nothing', () => {
  rmSync(m.beta.sailDir, { recursive: true });
  const beta = attention(index(m.registryDir)).filter((item) => item.repo === 'beta');
  expect(beta.map((item) => [item.kind, item.title, item.opens])).toEqual([['problem', 'repository', undefined]]);
  expect(beta[0]?.detail).toContain('no longer exists');
});

test('an item has one identity, equal for equal items and different when any one of its seven fields differs', () => {
  const base: AttentionItem = {
    repo: 'alpha',
    runId: 'r1',
    key: 'implement#1',
    workflow: 'w',
    kind: 'error',
    title: 'implement#1 ended in error',
    detail: 'boom',
  };
  expect(identity({ ...base })).toBe(identity(base));
  expect(identity({ ...base, opens: { repo: 'alpha', runId: 'r1' } })).toBe(identity(base));
  const changed: Partial<AttentionItem>[] = [
    { repo: 'beta' },
    { kind: 'failed' },
    { runId: 'r2' },
    { key: 'tests#1' },
    { workflow: 'x' },
    { title: 'parked after 3 attempts' },
    { detail: 'bang' },
  ];
  const ids = [base, ...changed.map((change) => ({ ...base, ...change }))].map(identity);
  expect(new Set(ids).size).toBe(8);
  const { runId: _runId, ...noRun } = base;
  expect(identity(noRun)).not.toBe(identity(base));
  expect(identity({ ...base, detail: 'a · b', title: 'c' })).not.toBe(
    identity({ ...base, detail: 'b', title: 'c · a' }),
  );
});
