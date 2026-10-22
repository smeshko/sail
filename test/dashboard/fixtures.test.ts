// The dashboard's recorded fixtures stay honest (D12): each run directory is one the engine could have written, its
// summary is what its events fold into, the queue is one the watcher could have written, and nothing names a machine
// or internal work. `test/fixtures/dashboard/<repo>/` holds what that clone's `.sail-runs/` holds; `seedFixtures()`
// copies it into a registered clone, beside the golden run in alpha.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { index } from '../../src/dashboard/files';
import { formatIssue, validateDocument, validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import { summarize } from '../../src/events/summary';
import { QueueFile } from '../../src/watch/queue-store';
import {
  DASHBOARD_FIXTURES,
  FAKE_2_ID,
  FAKE_3_ID,
  GOLDEN_RUN_ID,
  type Machine,
  QUEUE_WORKFLOW,
  seedFixtures,
} from '../helpers/dashboard';
import { FAKE_4_ID } from '../helpers/review-fixture';

const RUNS = { alpha: [FAKE_2_ID], beta: [FAKE_3_ID, FAKE_4_ID] };
const runDir = (repo: 'alpha' | 'beta', runId: string) => join(DASHBOARD_FIXTURES, repo, runId);
const QUEUE = join(DASHBOARD_FIXTURES, 'beta', 'queue', QUEUE_WORKFLOW);

let seeded: Machine | undefined;
afterEach(() => {
  seeded?.remove();
  seeded = undefined;
});

/** Every file under `dir`, relative to it. */
const filesIn = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('each recorded run passes validateRunDir, and its summary.json is summarize() of its events', () => {
  expect(readdirSync(join(DASHBOARD_FIXTURES, 'alpha')).sort()).toEqual([FAKE_2_ID]);
  expect(readdirSync(join(DASHBOARD_FIXTURES, 'beta')).sort()).toEqual([FAKE_3_ID, FAKE_4_ID, 'queue']);
  for (const [repo, ids] of Object.entries(RUNS) as ['alpha' | 'beta', string[]][]) {
    for (const id of ids) {
      const dir = runDir(repo, id);
      expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
      expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))).toEqual(summarize(readEvents(dir)));
    }
  }
  expect(readFileSync(join(runDir('alpha', FAKE_2_ID), 'STATUS'), 'utf8')).toBe('failed stage_error\n');
  expect(readFileSync(join(runDir('beta', FAKE_3_ID), 'STATUS'), 'utf8')).toBe('suspended budget_exceeded\n');
  expect(readFileSync(join(runDir('beta', FAKE_4_ID), 'STATUS'), 'utf8')).toBe('completed\n');
});

test("beta's queue.json is a QueueFile, and every line of its event stream is a sail.event.v1 queue event in seq order", () => {
  const queue = QueueFile.parse(JSON.parse(readFileSync(join(QUEUE, 'queue.json'), 'utf8')));
  expect(queue.items.map((item) => [item.dedupKey, item.state, item.attempts])).toEqual([
    ['ticket:FAKE-5', 'queued', 0],
    ['ticket:FAKE-3', 'dispatched', 1],
    ['ticket:FAKE-6', 'parked', 2],
    ['ticket:FAKE-4', 'done', 1],
  ]);
  expect(queue.items[1]?.runId).toBe(FAKE_3_ID);
  const lines = readFileSync(join(QUEUE, 'events.ndjson'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(lines.flatMap((line) => validateDocument('sail.event.v1', line))).toEqual([]);
  expect(lines.map((line) => `${line.seq} ${line.type}`)).toEqual([
    '1 watch:added',
    '2 queue:polled',
    '3 queue:item_added',
    '4 queue:item_added',
    '5 queue:item_added',
    '6 queue:item_added',
    '7 queue:error',
    '8 queue:polled',
    '9 queue:parked',
  ]);
  expect(lines.every((line) => line.runId === undefined && line.workflow === QUEUE_WORKFLOW)).toBe(true);
});

test('FAKE-2 holds exactly one denial, under implement#1, whose tool call asked for git push --force origin HEAD', () => {
  const events = readEvents(runDir('alpha', FAKE_2_ID));
  const denials = events.flatMap((event) => (event.type === 'permission:denied' ? [event] : []));
  expect(denials.map(({ key, tool, rule, callId }) => ({ key, tool, rule, callId }))).toEqual([
    { key: 'implement#1', tool: 'Bash', rule: 'commands', callId: 'toolu-1' },
  ]);
  const start = events.find((event) => event.type === 'tool:start' && event.callId === 'toolu-1');
  expect(start).toMatchObject({ key: 'implement#1', tool: 'Bash', input: { command: 'git push --force origin HEAD' } });
  const roster = events.find((event) => event.type === 'run:start');
  const commands = roster?.type === 'run:start' ? roster.roster.stages.implement?.permissions?.commands : undefined;
  expect(denials[0]?.permissions as unknown).toEqual({ commands });
  expect(events.at(-1)).toMatchObject({ type: 'run:end', status: 'failed', stopReason: 'stage_error' });
});

test("FAKE-3's roster has a lint stage the fixture repository's workflows don't have, and its ticket title is HTML", () => {
  const events = readEvents(runDir('beta', FAKE_3_ID));
  const start = events.find((event) => event.type === 'run:start');
  const stages = start?.type === 'run:start' ? Object.keys(start.roster.stages) : [];
  expect(stages).toEqual(['describe', 'implement', 'lint', 'open', 'self-review', 'spec', 'tests']);
  const sail = join(import.meta.dir, '..', 'fixtures', 'repo', '.sail');
  expect(existsSync(join(sail, 'stages', 'lint'))).toBe(false);
  expect(existsSync(join(sail, 'workflows', 'ticket-to-pr', 'stages', 'lint'))).toBe(false);
  const fetched = events.find((event) => event.type === 'ticket:fetched');
  expect(fetched).toMatchObject({ key: 'intake#1', ticketKey: 'FAKE-3', title: 'Escape <b>this</b> & "that"' });
  expect(events.filter((event) => event.type === 'budget:exceeded')).toMatchObject([{ budget: 'usd', limit: 1 }]);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ("seedFixtures registers alpha with the golden run and FAKE-2, and beta with FAKE-3, FAKE-4's review and its queue, each with its summary", () => {
  seeded = seedFixtures();
  const repos = index(seeded.registryDir);
  expect(
    repos.map((repo) => [
      repo.name,
      repo.problem,
      repo.runs.map((run) => [run.runId, run.summary?.runId, run.problem]),
    ]),
  ).toEqual([
    [
      'alpha',
      undefined,
      [
        [FAKE_2_ID, FAKE_2_ID, undefined],
        [GOLDEN_RUN_ID, GOLDEN_RUN_ID, undefined],
      ],
    ],
    [
      'beta',
      undefined,
      [
        [FAKE_4_ID, FAKE_4_ID, undefined],
        [FAKE_3_ID, FAKE_3_ID, undefined],
      ],
    ],
  ]);
  expect(existsSync(join(seeded.beta.clone, '.sail-runs', 'queue', QUEUE_WORKFLOW, 'queue.json'))).toBe(true);
});

test('no recorded file holds a path of this machine or names internal work', () => {
  const banned =
    /\/Users\/|\/private\/|\/var\/folders\/|\/home\/|sunrise|aws-hackaton|\bmaster\b|azure|dtgs|ADO-|rewe/i;
  const found = filesIn(DASHBOARD_FIXTURES).filter((file) =>
    banned.test(readFileSync(join(DASHBOARD_FIXTURES, file), 'utf8')),
  );
  expect(found).toEqual([]);
  expect(filesIn(DASHBOARD_FIXTURES).length).toBeGreaterThan(40);
});
