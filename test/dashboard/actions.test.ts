// What a run offers its viewer: Resume or Restart, enabled or why not, over copies of the dashboard's recorded runs.
// alpha holds the golden run and FAKE-2 (failed, its implement call in error); beta holds FAKE-3 (suspended on its
// budget, its queue item dispatched) and FAKE-4 (a completed group).
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeLease } from '../../src/adapters/leases';
import { runActions } from '../../src/dashboard/actions';
import {
  appendEvent,
  entryOf,
  FAKE_2_ID,
  FAKE_3_ID,
  GOLDEN_RUN_ID,
  type Machine,
  queueDirOf,
  seedFixtures,
} from '../helpers/dashboard';
import { FAKE_4_ID } from '../helpers/review-fixture';

let m: Machine;
let leasesDir: string;
beforeEach(() => {
  m = seedFixtures();
  leasesDir = join(m.root, 'leases');
  mkdirSync(leasesDir);
});
afterEach(() => m.remove());

const alpha = () => entryOf(m.alpha);
const beta = () => entryOf(m.beta);
const runDir = (clone: 'alpha' | 'beta', runId: string) => join(m[clone].clone, '.sail-runs', runId);
const actions = (clone: 'alpha' | 'beta', runId: string) =>
  runActions(clone === 'alpha' ? alpha() : beta(), runId, { leasesDir });
const setStatus = (dir: string, status: string) => writeFileSync(join(dir, 'STATUS'), `${status}\n`);
const change = (file: string, from: string, to: string) => {
  const text = readFileSync(file, 'utf8');
  expect(text).toContain(from);
  writeFileSync(file, text.replace(from, to));
};
const queueFile = () => join(queueDirOf(m), 'queue.json');
const FAKE_3_BRANCH = 'sail/FAKE-3-escape-b-this-b-that';

/** FAKE-3's queue item, as the watcher left it: settled, so nothing holds the run. */
const settleQueue = () => change(queueFile(), '"state": "dispatched"', '"state": "done"');

test('a budget-suspended run offers Resume with what it spent, its budget and the dollars it must raise', () => {
  settleQueue();
  expect(actions('beta', FAKE_3_ID)).toEqual({
    resume: { enabled: true, spentUsd: 1.0625, budget: { maxUsd: 1, maxMinutes: 90 }, raise: 'usd' },
  });
});

test('a run suspended over its minutes names the minutes it used and asks for minutes', () => {
  settleQueue();
  appendEvent(runDir('beta', FAKE_3_ID), 'run:suspended', {
    stopReason: 'budget_exceeded',
    budget: 'minutes',
    limit: 90,
    used: 91.5,
  });
  expect(actions('beta', FAKE_3_ID).resume).toEqual({
    enabled: true,
    spentUsd: 1.0625,
    spentMinutes: 91.5,
    budget: { maxUsd: 1, maxMinutes: 90 },
    raise: 'minutes',
  });
});

test('a raised budget is the one Resume shows, and a run under its dollars is asked for minutes', () => {
  settleQueue();
  appendEvent(runDir('beta', FAKE_3_ID), 'budget:raised', { usd: 5, budget: { maxUsd: 6, maxMinutes: 90 } });
  expect(actions('beta', FAKE_3_ID).resume).toEqual({
    enabled: true,
    spentUsd: 1.0625,
    budget: { maxUsd: 6, maxMinutes: 90 },
    raise: 'minutes',
  });
});

test('a run suspended for another reason offers Resume with no raise', () => {
  settleQueue();
  setStatus(runDir('beta', FAKE_3_ID), 'suspended until');
  expect(actions('beta', FAKE_3_ID).resume).toEqual({
    enabled: true,
    spentUsd: 1.0625,
    budget: { maxUsd: 1, maxMinutes: 90 },
  });
});

test('a failed ticket run offers Restart with its stages in the order they ran, and the stage it failed in as default', () => {
  expect(actions('alpha', FAKE_2_ID)).toEqual({
    restart: {
      enabled: true,
      stages: [
        { stage: 'spec', runsAgain: 'spec#1 and everything after it' },
        { stage: 'implement', runsAgain: 'implement#1 and everything after it, in loop fix from iteration 1' },
      ],
      stage: 'implement',
      budget: { maxUsd: 25, maxMinutes: 90 },
    },
  });
});

test('a completed run offers neither, and says it completed', () => {
  expect(actions('beta', FAKE_4_ID)).toEqual({
    why: `run ${FAKE_4_ID} completed: there is nothing to start again`,
  });
});

test('a running run offers both, disabled, saying it is running', () => {
  setStatus(runDir('alpha', FAKE_2_ID), 'running');
  const why = `run ${FAKE_2_ID} is running`;
  expect(actions('alpha', FAKE_2_ID)).toEqual({
    resume: { enabled: false, why, spentUsd: 0.3625, budget: { maxUsd: 25, maxMinutes: 90 } },
    restart: { enabled: false, why, stages: [], budget: { maxUsd: 25, maxMinutes: 90 } },
  });
});

test('a run whose branch another run holds offers its action disabled, naming that run', () => {
  const held = takeLease(leasesDir, 'fake://origin', FAKE_3_BRANCH, {
    runId: 'FAKE-9-01HZX3Y4Z5A6B7C8D9E0F1G2H3',
    runDir: m.root,
    pid: process.pid,
  });
  expect(held.leased).toBe(true);
  settleQueue();
  expect(actions('beta', FAKE_3_ID).resume).toMatchObject({
    enabled: false,
    why: `branch ${FAKE_3_BRANCH} is leased by run FAKE-9-01HZX3Y4Z5A6B7C8D9E0F1G2H3`,
  });
});

test('a lease the run holds itself leaves its Resume enabled', () => {
  takeLease(leasesDir, 'fake://origin', FAKE_3_BRANCH, {
    runId: FAKE_3_ID,
    runDir: runDir('beta', FAKE_3_ID),
    pid: process.pid,
  });
  settleQueue();
  expect(actions('beta', FAKE_3_ID).resume?.enabled).toBe(true);
});

test('a failed run whose branch another run holds offers Restart disabled, naming that run, with its stages kept', () => {
  takeLease(leasesDir, 'fake://origin', 'sail/FAKE-2-print-the-version-with-version', {
    runId: 'FAKE-9-01HZX3Y4Z5A6B7C8D9E0F1G2H3',
    runDir: m.root,
    pid: process.pid,
  });
  const { restart } = actions('alpha', FAKE_2_ID);
  expect([restart?.enabled, restart?.why, restart?.stages.map((each) => each.stage)]).toEqual([
    false,
    'branch sail/FAKE-2-print-the-version-with-version is leased by run FAKE-9-01HZX3Y4Z5A6B7C8D9E0F1G2H3',
    ['spec', 'implement'],
  ]);
});

test('a dispatched queue item naming the run disables Resume, saying the watcher has it', () => {
  expect(actions('beta', FAKE_3_ID).resume).toMatchObject({
    enabled: false,
    why: "ticket-to-pr's watcher has this run: ticket:FAKE-3 is dispatched",
  });
});

test('a failed queue item with a retry time disables Resume, and one without it does not', () => {
  change(queueFile(), '"state": "dispatched"', '"state": "failed",\n      "retryAt": "2026-09-24T12:00:00.000Z"');
  const waiting = actions('beta', FAKE_3_ID).resume;
  change(queueFile(), ',\n      "retryAt": "2026-09-24T12:00:00.000Z"', '');
  const parked = actions('beta', FAKE_3_ID).resume;
  expect([waiting?.enabled, waiting?.why, parked?.enabled]).toEqual([
    false,
    "ticket-to-pr's watcher will run ticket:FAKE-3 again at 2026-09-24T12:00:00.000Z",
    true,
  ]);
});

test('a pull-request run offers Restart disabled, in the seeded run refusal words', () => {
  change(
    join(runDir('alpha', FAKE_2_ID), 'run.json'),
    '"kind": "ticket",\n    "ticketKey": "FAKE-2",\n    "via": "cli",',
    '"kind": "pr",\n    "number": 7,\n    "headSha": "4203211311dad98c507528d05a25fff53b821b31",\n    "via": "cli",',
  );
  expect(actions('alpha', FAKE_2_ID).restart).toEqual({
    enabled: false,
    why: `a seeded run starts from a ticket run: run ${FAKE_2_ID} started from pull request #7`,
    stages: [],
    budget: { maxUsd: 25, maxMinutes: 90 },
  });
});

test('a run with no branch offers Restart disabled, saying it started before workspaces', () => {
  change(join(runDir('alpha', FAKE_2_ID), 'run.json'), '"branch": "sail/FAKE-2-print-the-version-with-version",', '');
  expect(actions('alpha', FAKE_2_ID).restart?.why).toBe(
    `run ${FAKE_2_ID} started before runs had workspaces: it can't seed a run`,
  );
});

test('a run whose intake failed offers Restart disabled, saying there is nothing to reuse', () => {
  change(join(runDir('alpha', FAKE_2_ID), 'journal.ndjson'), '"outcome":"passed"', '"outcome":"error"');
  expect(actions('alpha', FAKE_2_ID).restart?.why).toBe(
    `run ${FAKE_2_ID}'s intake didn't pass: there is nothing to reuse`,
  );
});

test('a failed run that ran no stage past its intake offers Restart disabled', () => {
  const journal = join(runDir('alpha', FAKE_2_ID), 'journal.ndjson');
  writeFileSync(journal, `${readFileSync(journal, 'utf8').split('\n')[0]}\n`);
  expect(actions('alpha', FAKE_2_ID).restart).toMatchObject({
    enabled: false,
    why: `run ${FAKE_2_ID} ran no stage a seeded run can start from`,
    stages: [],
  });
});

test("a failed run's group names its calls together, and the stages come in the order they first ran", () => {
  setStatus(runDir('beta', FAKE_4_ID), 'failed stage_error');
  const group = 'style#1, architecture#1, side-effects#1, performance#1, security#1, coverage#1';
  const { restart } = actions('beta', FAKE_4_ID);
  expect([restart?.stages.map((each) => each.stage), restart?.stages[0]?.runsAgain, restart?.stage]).toEqual([
    ['coverage', 'security', 'performance', 'side-effects', 'architecture', 'style'],
    `the group ${group} and everything after it`,
    'style',
  ]);
});

test('a failed run names the loop a stage ran in and the steps of a multi-step stage, and defaults to the failed call', () => {
  setStatus(runDir('alpha', GOLDEN_RUN_ID), 'failed workflow_failed');
  const { restart } = actions('alpha', GOLDEN_RUN_ID);
  expect(restart?.stages).toEqual([
    { stage: 'spec', runsAgain: 'spec#1 and everything after it' },
    { stage: 'implement', runsAgain: 'implement#1 and everything after it, in loop fix from iteration 1' },
    { stage: 'tests', runsAgain: 'tests#1 and everything after it, in loop fix from iteration 1' },
    { stage: 'self-review', runsAgain: 'self-review#1 and everything after it, in loop fix from iteration 2' },
    { stage: 'publish', runsAgain: 'publish#1, every step of it, and everything after it' },
  ]);
  expect(restart?.stage).toBe('tests');
});

test('a run that is no run of the repository offers nothing, saying so', () => {
  expect(actions('alpha', 'FAKE-0-NOPE')).toEqual({ why: "no run 'FAKE-0-NOPE' in alpha" });
});

test('a run whose STATUS is gone offers nothing, saying it can not be read', () => {
  rmSync(join(runDir('alpha', FAKE_2_ID), 'STATUS'));
  expect(actions('alpha', FAKE_2_ID).why).toStartWith(`run ${FAKE_2_ID} can't be read: `);
});
