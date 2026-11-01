// What a run offers its viewer: Resume, Restart, Stop and Clean, enabled or why not, over copies of the dashboard's recorded runs.
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
  fakeClonePorts,
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

const ARCHIVE = /\/failed-runs\/\d{4}-\d{2}-\d{2}\/FAKE-2-01M36VAD801GH3GKJTE239SCP8$/;
const alpha = () => entryOf(m.alpha);
const beta = () => entryOf(m.beta);
const runDir = (clone: 'alpha' | 'beta', runId: string) => join(m[clone].clone, '.sail-runs', runId);
const actions = (clone: 'alpha' | 'beta', runId: string, ports = fakeClonePorts(leasesDir)) =>
  runActions(clone === 'alpha' ? alpha() : beta(), runId, { leasesDir, ports, env: { SAIL_HOME: m.sailHome } });
const setStatus = (dir: string, status: string) => writeFileSync(join(dir, 'STATUS'), `${status}\n`);
const change = (file: string, from: string, to: string) => {
  const text = readFileSync(file, 'utf8');
  expect(text).toContain(from);
  writeFileSync(file, text.replace(from, to));
};
const queueFile = () => join(queueDirOf(m), 'queue.json');
const FAKE_2_BRANCH = 'sail/FAKE-2-print-the-version-with-version';
const FAKE_3_BRANCH = 'sail/FAKE-3-escape-b-this-b-that';

/** FAKE-3's queue item, as the watcher left it: settled, so nothing holds the run. */
const settleQueue = () => change(queueFile(), '"state": "dispatched"', '"state": "done"');

test('a budget-suspended run offers Resume with what it spent, its budget and the dollars it must raise', async () => {
  settleQueue();
  expect(await actions('beta', FAKE_3_ID)).toEqual({
    resume: { enabled: true, spentUsd: 1.0625, budget: { maxUsd: 1, maxMinutes: 90 }, raise: 'usd' },
    stop: { enabled: true },
  });
});

test('a run suspended over its minutes names the minutes it used and asks for minutes', async () => {
  settleQueue();
  appendEvent(runDir('beta', FAKE_3_ID), 'run:suspended', {
    stopReason: 'budget_exceeded',
    budget: 'minutes',
    limit: 90,
    used: 91.5,
  });
  expect((await actions('beta', FAKE_3_ID)).resume).toEqual({
    enabled: true,
    spentUsd: 1.0625,
    spentMinutes: 91.5,
    budget: { maxUsd: 1, maxMinutes: 90 },
    raise: 'minutes',
  });
});

test('a raised budget is the one Resume shows, and a run under its dollars is asked for minutes', async () => {
  settleQueue();
  appendEvent(runDir('beta', FAKE_3_ID), 'budget:raised', { usd: 5, budget: { maxUsd: 6, maxMinutes: 90 } });
  expect((await actions('beta', FAKE_3_ID)).resume).toEqual({
    enabled: true,
    spentUsd: 1.0625,
    budget: { maxUsd: 6, maxMinutes: 90 },
    raise: 'minutes',
  });
});

test('a run suspended for another reason offers Resume with no raise', async () => {
  settleQueue();
  setStatus(runDir('beta', FAKE_3_ID), 'suspended until');
  expect((await actions('beta', FAKE_3_ID)).resume).toEqual({
    enabled: true,
    spentUsd: 1.0625,
    budget: { maxUsd: 1, maxMinutes: 90 },
  });
});

test('a failed ticket run offers Restart with its stages in the order they ran, and the stage it failed in as default', async () => {
  expect(await actions('alpha', FAKE_2_ID)).toEqual({
    restart: {
      enabled: true,
      stages: [
        { stage: 'spec', runsAgain: 'spec#1 and everything after it' },
        { stage: 'implement', runsAgain: 'implement#1 and everything after it, in loop fix from iteration 1' },
      ],
      stage: 'implement',
      budget: { maxUsd: 25, maxMinutes: 90 },
    },
    clean: { enabled: true, removes: ['run ref'], archive: expect.stringMatching(ARCHIVE) },
  });
});

test('a completed run offers neither, and says it completed', async () => {
  expect(await actions('beta', FAKE_4_ID)).toEqual({
    why: `run ${FAKE_4_ID} completed: there is nothing to start again`,
  });
});

test('a running run offers both, disabled, saying it is running', async () => {
  setStatus(runDir('alpha', FAKE_2_ID), 'running');
  const why = `run ${FAKE_2_ID} is running`;
  expect(await actions('alpha', FAKE_2_ID)).toEqual({
    resume: { enabled: false, why, spentUsd: 0.3625, budget: { maxUsd: 25, maxMinutes: 90 } },
    restart: { enabled: false, why, stages: [], budget: { maxUsd: 25, maxMinutes: 90 } },
    stop: { enabled: true },
  });
});

test('a run whose branch another run holds offers its action disabled, naming that run', async () => {
  const held = takeLease(leasesDir, 'fake://origin', FAKE_3_BRANCH, {
    runId: 'FAKE-9-01HZX3Y4Z5A6B7C8D9E0F1G2H3',
    runDir: m.root,
    pid: process.pid,
  });
  expect(held.leased).toBe(true);
  settleQueue();
  expect((await actions('beta', FAKE_3_ID)).resume).toMatchObject({
    enabled: false,
    why: `branch ${FAKE_3_BRANCH} is leased by run FAKE-9-01HZX3Y4Z5A6B7C8D9E0F1G2H3`,
  });
});

test('a lease the run holds itself leaves its Resume enabled', async () => {
  takeLease(leasesDir, 'fake://origin', FAKE_3_BRANCH, {
    runId: FAKE_3_ID,
    runDir: runDir('beta', FAKE_3_ID),
    pid: process.pid,
  });
  settleQueue();
  expect((await actions('beta', FAKE_3_ID)).resume?.enabled).toBe(true);
});

test('a failed run whose branch another run holds offers Restart disabled, naming that run, with its stages kept', async () => {
  takeLease(leasesDir, 'fake://origin', 'sail/FAKE-2-print-the-version-with-version', {
    runId: 'FAKE-9-01HZX3Y4Z5A6B7C8D9E0F1G2H3',
    runDir: m.root,
    pid: process.pid,
  });
  const { restart } = await actions('alpha', FAKE_2_ID);
  expect([restart?.enabled, restart?.why, restart?.stages.map((each) => each.stage)]).toEqual([
    false,
    'branch sail/FAKE-2-print-the-version-with-version is leased by run FAKE-9-01HZX3Y4Z5A6B7C8D9E0F1G2H3',
    ['spec', 'implement'],
  ]);
});

test('a dispatched queue item naming the run disables Resume, saying the watcher has it', async () => {
  expect((await actions('beta', FAKE_3_ID)).resume).toMatchObject({
    enabled: false,
    why: "ticket-to-pr's watcher has this run: ticket:FAKE-3 is dispatched",
  });
});

test('a failed queue item with a retry time disables Resume, and one without it does not', async () => {
  change(queueFile(), '"state": "dispatched"', '"state": "failed",\n      "retryAt": "2026-09-24T12:00:00.000Z"');
  const waiting = (await actions('beta', FAKE_3_ID)).resume;
  change(queueFile(), ',\n      "retryAt": "2026-09-24T12:00:00.000Z"', '');
  const parked = (await actions('beta', FAKE_3_ID)).resume;
  expect([waiting?.enabled, waiting?.why, parked?.enabled]).toEqual([
    false,
    "ticket-to-pr's watcher will run ticket:FAKE-3 again at 2026-09-24T12:00:00.000Z",
    true,
  ]);
});

test('a pull-request run offers Restart disabled, in the seeded run refusal words', async () => {
  change(
    join(runDir('alpha', FAKE_2_ID), 'run.json'),
    '"kind": "ticket",\n    "ticketKey": "FAKE-2",\n    "via": "cli",',
    '"kind": "pr",\n    "number": 7,\n    "headSha": "4203211311dad98c507528d05a25fff53b821b31",\n    "via": "cli",',
  );
  expect((await actions('alpha', FAKE_2_ID)).restart).toEqual({
    enabled: false,
    why: `a seeded run starts from a ticket run: run ${FAKE_2_ID} started from pull request #7`,
    stages: [],
    budget: { maxUsd: 25, maxMinutes: 90 },
  });
});

test('a run with no branch offers Restart disabled, saying it started before workspaces', async () => {
  change(join(runDir('alpha', FAKE_2_ID), 'run.json'), '"branch": "sail/FAKE-2-print-the-version-with-version",', '');
  expect((await actions('alpha', FAKE_2_ID)).restart?.why).toBe(
    `run ${FAKE_2_ID} started before runs had workspaces: it can't seed a run`,
  );
});

test('a run whose intake failed offers Restart disabled, saying there is nothing to reuse', async () => {
  change(join(runDir('alpha', FAKE_2_ID), 'journal.ndjson'), '"outcome":"passed"', '"outcome":"error"');
  expect((await actions('alpha', FAKE_2_ID)).restart?.why).toBe(
    `run ${FAKE_2_ID}'s intake didn't pass: there is nothing to reuse`,
  );
});

test('a failed run that ran no stage past its intake offers Restart disabled', async () => {
  const journal = join(runDir('alpha', FAKE_2_ID), 'journal.ndjson');
  writeFileSync(journal, `${readFileSync(journal, 'utf8').split('\n')[0]}\n`);
  expect((await actions('alpha', FAKE_2_ID)).restart).toMatchObject({
    enabled: false,
    why: `run ${FAKE_2_ID} ran no stage a seeded run can start from`,
    stages: [],
  });
});

test("a failed run's group names its calls together, and the stages come in the order they first ran", async () => {
  setStatus(runDir('beta', FAKE_4_ID), 'failed stage_error');
  const group = 'style#1, architecture#1, side-effects#1, performance#1, security#1, coverage#1';
  const { restart } = await actions('beta', FAKE_4_ID);
  expect([restart?.stages.map((each) => each.stage), restart?.stages[0]?.runsAgain, restart?.stage]).toEqual([
    ['coverage', 'security', 'performance', 'side-effects', 'architecture', 'style'],
    `the group ${group} and everything after it`,
    'style',
  ]);
});

test('a failed run names the loop a stage ran in and the steps of a multi-step stage, and defaults to the failed call', async () => {
  setStatus(runDir('alpha', GOLDEN_RUN_ID), 'failed workflow_failed');
  const { restart } = await actions('alpha', GOLDEN_RUN_ID);
  expect(restart?.stages).toEqual([
    { stage: 'spec', runsAgain: 'spec#1 and everything after it' },
    { stage: 'implement', runsAgain: 'implement#1 and everything after it, in loop fix from iteration 1' },
    { stage: 'tests', runsAgain: 'tests#1 and everything after it, in loop fix from iteration 1' },
    { stage: 'self-review', runsAgain: 'self-review#1 and everything after it, in loop fix from iteration 2' },
    { stage: 'publish', runsAgain: 'publish#1, every step of it, and everything after it' },
  ]);
  expect(restart?.stage).toBe('tests');
});

test('a run that is no run of the repository offers nothing, saying so', async () => {
  expect(await actions('alpha', 'FAKE-0-NOPE')).toEqual({ why: "no run 'FAKE-0-NOPE' in alpha" });
});

test('a run whose STATUS is gone offers nothing, saying it can not be read', async () => {
  rmSync(join(runDir('alpha', FAKE_2_ID), 'STATUS'));
  expect((await actions('alpha', FAKE_2_ID)).why).toStartWith(`run ${FAKE_2_ID} can't be read: `);
});

test('a suspended run offers Stop beside Resume, and a running run offers Stop with Resume and Restart disabled', async () => {
  settleQueue();
  expect((await actions('beta', FAKE_3_ID)).stop).toEqual({ enabled: true });
  setStatus(runDir('beta', FAKE_3_ID), 'running');
  expect((await actions('beta', FAKE_3_ID)).stop).toEqual({ enabled: true });
});

test('Stop stays enabled while a watcher has the run, since sail stop stops a dispatched run', async () => {
  expect((await actions('beta', FAKE_3_ID)).stop).toEqual({ enabled: true });
});

test('a completed or a failed run offers no Stop', async () => {
  expect((await actions('beta', FAKE_4_ID)).stop).toBeUndefined();
  expect((await actions('alpha', FAKE_2_ID)).stop).toBeUndefined();
});

test('a dispatched run that is still starting, with no run.json yet, offers Stop', async () => {
  const startingId = 'FAKE-5-01M3BWNZM08Q4T6V2XRJ5KWD9Z';
  change(queueFile(), '"runId": "FAKE-3-01M39H4ZW0S46MV303CFX3T4PY"', `"runId": "${startingId}"`);
  expect(await actions('beta', startingId)).toEqual({ stop: { enabled: true } });
});

test('a failed run offers Clean with what it removes and where its directory goes, beside Restart', async () => {
  const offers = await actions(
    'alpha',
    FAKE_2_ID,
    fakeClonePorts(leasesDir, { branches: { local: true, remote: true } }),
  );
  expect(offers.restart?.enabled).toBe(true);
  expect(offers.clean).toEqual({
    enabled: true,
    removes: [`branch ${FAKE_2_BRANCH}`, 'remote branch', 'run ref'],
    archive: expect.stringMatching(ARCHIVE),
  });
  expect(offers.clean?.archive?.startsWith(m.sailHome)).toBe(true);
});

test("Clean is disabled for an open pull request, in sail clean's words", async () => {
  const open = { number: 9, url: 'https://example.test/pull/9' };
  const ports = fakeClonePorts(leasesDir, {
    branches: { local: true, remote: true },
    codeHost: { pullRequestFrom: async () => open as never },
  });
  expect((await actions('alpha', FAKE_2_ID, ports)).clean).toEqual({
    enabled: false,
    removes: [],
    why: `run ${FAKE_2_ID}: its branch ${FAKE_2_BRANCH} has an open pull request, #9 (https://example.test/pull/9): close it first`,
  });
});

test('Clean is disabled while a queue item names the run, saying requeue or drop', async () => {
  const dir = join(runDir('alpha', FAKE_2_ID), '..', 'queue', 'ticket-to-pr');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'queue.json'),
    readFileSync(queueFile(), 'utf8')
      .replace('FAKE-3-01M39H4ZW0S46MV303CFX3T4PY', FAKE_2_ID)
      .replace('"dispatched"', '"parked",\n"reason": "gave up"'),
  );
  const { clean } = await actions('alpha', FAKE_2_ID);
  expect([clean?.enabled, clean?.why]).toEqual([
    false,
    expect.stringContaining('names run FAKE-2-01M36VAD801GH3GKJTE239SCP8: requeue it or drop it'),
  ]);
});

test('Clean is disabled while another run leases the branch, naming that run', async () => {
  takeLease(leasesDir, 'fake://origin', FAKE_2_BRANCH, {
    runId: 'FAKE-9-01HZX3Y4Z5A6B7C8D9E0F1G2H3',
    runDir: m.root,
    pid: process.pid,
  });
  const { clean } = await actions('alpha', FAKE_2_ID);
  expect(clean?.why).toBe(
    `run ${FAKE_2_ID}: its branch ${FAKE_2_BRANCH} is leased by run FAKE-9-01HZX3Y4Z5A6B7C8D9E0F1G2H3`,
  );
  expect(clean?.enabled).toBe(false);
});

test("Clean is disabled with the resolution issues when the clone's ports cannot be resolved", async () => {
  const { clean } = await actions('alpha', FAKE_2_ID, async () => ({ refused: '/adapters/workspace: no adapter' }));
  expect(clean).toEqual({ enabled: false, removes: [], why: '/adapters/workspace: no adapter' });
});

test('with no ports given, a clone without a project.yaml disables Clean, saying so', async () => {
  const { clean } = await runActions(alpha(), FAKE_2_ID, { leasesDir, env: { SAIL_HOME: m.sailHome } });
  expect(clean?.enabled).toBe(false);
  expect(clean?.why).toBe('[sail.project.v1]  / is missing');
});
