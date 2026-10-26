// runSeededWorkflow(): a seeded run driven by the runtime's one loop, on the fixture repository's fakes. The source is
// `sail FAKE-1` run to its end once in a repository of its own, and each case seeds from a copy of it: a process opens
// one run per `.sail/`, so a resume runs in a copy of the seeded run's repository.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournal } from '../../src/engine/journal';
import { type RunEnd, resumeWorkflow, runSeededWorkflow, runWorkflow } from '../../src/engine/runtime';
import { formatIssue, validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { Summary } from '../../src/events/summary';
import { fakeAdapters } from '../helpers/adapters';
import { AGENT_WORKFLOW } from '../helpers/agent-fixture';
import { edit } from '../helpers/fixture';
import { TRIO, TRIO_GROUP, TRIO_JOURNAL, trioRunInto } from '../helpers/review-fixture';
import { SOURCE_BRANCH, SOURCE_JOURNAL, sharedSource } from '../helpers/seeded';
import { copyRun } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';
import { writeTwoStep } from '../helpers/two-step';

const source = sharedSource();
afterAll(() => source.release());

const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';

const FAKE_TICKET = {
  ticketKey: 'FAKE-1',
  title: 'Add a --shout flag to the greet command',
  url: expect.stringContaining('FAKE-1'),
};

const journaled = (dir: string) => readJournal(dir).entries.map((entry) => `${entry.key} ${entry.outcome}`);
const issuesOf = (dir: string) => validateRunDir(dir).issues.map(formatIssue);

/** A seeded run of the copied source in `repo`, seeded for `stage`. */
async function seeded(repo: TempRepo, fromRun: string, stage: string, more: { continue?: boolean } = {}) {
  return runSeededWorkflow({ cwd: repo.dir, fromRun, stage, ...more, adapters: await fakeAdapters(repo.dir) });
}

/** How a run ended, as far as a test compares it: its status and stop reason, or its refusal. */
const endOf = (end: RunEnd | { refused: string }) =>
  'refused' in end ? end : { status: end.status, stopReason: end.stopReason };

/** The run's directory once a test has asserted how it ended. */
const dirOf = (end: RunEnd | { refused: string }) => ('refused' in end ? '' : end.dir);

test('seeding spec runs spec#1 alone after the reused intake, reports the intake as a reused call, and stops suspended with until', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const end = await seeded(repo, from.runId, 'spec');
    expect(endOf(end)).toEqual({ status: 'suspended', stopReason: 'until' });
    const dir = dirOf(end);
    const events = readEvents(dir);
    const start = events[0] as { type: string; fromRun?: string };
    const appended = events.flatMap((event) =>
      event.type === 'journal:append' ? [{ key: event.key, line: event.line, fromRun: event.fromRun }] : [],
    );
    const order = (find: (event: (typeof events)[number]) => boolean) => events.findIndex(find);
    const summary: Summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    const sourceSummary: Summary = JSON.parse(readFileSync(join(from.dir, 'summary.json'), 'utf8'));
    const reusedIntake = events.find((event) => event.type === 'journal:append' && event.key === 'intake#1');
    expect({
      journal: journaled(dir),
      ticket: summary.ticket,
      sourceTicket: sourceSummary.ticket,
      sameTicket: summary.ticket?.url !== undefined && summary.ticket.url === sourceSummary.ticket?.url,
      intakeTicket: reusedIntake?.type === 'journal:append' ? reusedIntake.ticket : undefined,
      fetched: events.some((event) => event.type === 'ticket:fetched'),
      start: [start.type, start.fromRun],
      appended,
      intakeStarted: events.some((event) => event.type === 'intake:start'),
      reusedBeforeSpec:
        order((event) => event.type === 'journal:append' && event.key === 'intake#1') <
        order((event) => event.type === 'stage:start' && event.key === 'spec#1'),
      calls: summary.calls.map(({ key, durationMs, fromRun }) => ({
        key,
        ...(fromRun ? { durationMs, fromRun } : {}),
      })),
      stageCalls: summary.totals.stageCalls,
      issues: issuesOf(dir),
    }).toEqual({
      journal: ['intake#1 passed', 'spec#1 done'],
      ticket: FAKE_TICKET,
      sourceTicket: FAKE_TICKET,
      sameTicket: true,
      intakeTicket: FAKE_TICKET,
      fetched: false,
      start: ['run:start', from.runId],
      appended: [
        { key: 'intake#1', line: 1, fromRun: from.runId },
        { key: 'spec#1', line: 2, fromRun: undefined },
      ],
      intakeStarted: false,
      reusedBeforeSpec: true,
      calls: [{ key: 'intake#1', durationMs: 0, fromRun: from.runId }, { key: 'spec#1' }],
      stageCalls: 1,
      issues: [],
    });
  });
}, 60_000);

test('a run seeded from a seeded run names the same ticket in its summary, though neither fetched it', async () => {
  await withTempRepo(async (first) => {
    const from = await source.copyInto(first.dir);
    const stopped = await seeded(first, from.runId, 'spec');
    expect(endOf(stopped)).toEqual({ status: 'suspended', stopReason: 'until' });
    const middle = 'refused' in stopped ? '' : stopped.runId;
    await withTempRepo(async (second) => {
      copyRun(first.dir, second.dir);
      const end = await seeded(second, middle, 'spec');
      expect(endOf(end)).toEqual({ status: 'suspended', stopReason: 'until' });
      const dir = dirOf(end);
      const summary: Summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
      const original: Summary = JSON.parse(readFileSync(join(from.dir, 'summary.json'), 'utf8'));
      expect([summary.ticket, summary.ticket?.url, issuesOf(dir)]).toEqual([FAKE_TICKET, original.ticket?.url, []]);
    });
  });
}, 90_000);

test('with continue, a run seeded for spec runs to its end with the calls of the source, and opens its pull request from its own branch', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const end = await seeded(repo, from.runId, 'spec', { continue: true });
    expect(endOf(end)).toEqual({ status: 'completed', stopReason: undefined });
    const dir = dirOf(end);
    const header = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    const prs = JSON.parse(readFileSync(join(repo.dir, '.sail-runs', 'fake', 'prs.json'), 'utf8'));
    const heads: string[] = prs.pullRequests.map((pr: { head: string }) => pr.head);
    expect({
      journal: journaled(dir),
      branch: header.branch.startsWith(`${SOURCE_BRANCH}-seeded-`),
      opened: heads.includes(header.branch),
      issues: issuesOf(dir),
    }).toEqual({ journal: SOURCE_JOURNAL, branch: true, opened: true, issues: [] });
  });
}, 60_000);

test('a resume takes a run seeded for spec to its end, in the workspace it was seeded with', async () => {
  await withTempRepo(async (first) => {
    const from = await source.copyInto(first.dir);
    const stopped = await seeded(first, from.runId, 'spec');
    expect(endOf(stopped)).toEqual({ status: 'suspended', stopReason: 'until' });
    const runId = 'refused' in stopped ? '' : stopped.runId;
    await withTempRepo(async (second) => {
      copyRun(first.dir, second.dir);
      const end = await resumeWorkflow({ cwd: second.dir, runId, adapters: await fakeAdapters(second.dir) });
      const dir = dirOf(end);
      const created = readEvents(dir).filter((event) => event.type === 'workspace:created');
      expect([endOf(end), journaled(dir), created.length, issuesOf(dir)]).toEqual([
        { status: 'completed', stopReason: undefined },
        SOURCE_JOURNAL,
        1,
        [],
      ]);
    });
  });
}, 60_000);

test('a workflow edited so the reused calls no longer fit fails the seeded run with determinism_violation, and releases its lease and workspace', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    edit(
      join(repo.dir, '.sail'),
      WORKFLOW,
      '    const s = await run.stage(spec,',
      '    await run.stage(tests);\n    const s = await run.stage(spec,',
    );
    const end = await seeded(repo, from.runId, 'self-review');
    expect(endOf(end)).toEqual({ status: 'failed', stopReason: 'determinism_violation' });
    const dir = dirOf(end);
    const branch = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).branch;
    const { workspace } = (await fakeAdapters(repo.dir)).ports;
    expect([await workspace.holder('fake://origin', branch), existsSync(join(dir, 'workspace'))]).toEqual([
      undefined,
      false,
    ]);
  });
}, 60_000);

// Review round 3: a seeded run runs the stage it was seeded for next, and nothing else first.
test('a seeded run whose edited workflow asks for another call before the stage fails with determinism_violation, and runs neither', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    edit(
      join(repo.dir, '.sail'),
      WORKFLOW,
      '    const p = await run.stage(publish',
      '    await run.stage(tests);\n    const p = await run.stage(publish',
    );
    const end = await seeded(repo, from.runId, 'publish', { continue: true });
    expect([endOf(end), 'refused' in end ? '' : end.message, journaled(dirOf(end)).at(-1)]).toEqual([
      { status: 'failed', stopReason: 'determinism_violation' },
      `the workflow asks for tests#3 after the calls reused from run ${from.runId}, not publish#1: it changed since that run`,
      'self-review#1 done',
    ]);
  });
}, 60_000);

// Review round 3: the repository is registered once the run's start and reused calls are in its events file, so a
// crash while registering leaves a run its events describe.
test('onOpened runs once the run start and the reused calls are in the events file', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const seen: string[] = [];
    const end = await runSeededWorkflow({
      cwd: repo.dir,
      fromRun: from.runId,
      stage: 'spec',
      adapters: await fakeAdapters(repo.dir),
      onOpened: async () => {
        const runId = readdirSync(join(repo.dir, '.sail-runs')).find((id) => id !== from.runId && id !== 'fake');
        const events = readEvents(join(repo.dir, '.sail-runs', runId ?? ''));
        seen.push(...events.map((event) => ('fromRun' in event ? `${event.type} ${event.fromRun}` : event.type)));
      },
    });
    expect([endOf(end), seen.filter((type) => type !== 'workspace:leased' && type !== 'workspace:created')]).toEqual([
      { status: 'suspended', stopReason: 'until' },
      [`run:start ${from.runId}`, `journal:append ${from.runId}`],
    ]);
  });
}, 60_000);

// A group: trio's a, b and c, journaled b, c, a in the source, then d.

test('a run seeded for a stage of a group runs the whole group as its first move, then stops with until; with --continue it runs on to the end', async () => {
  await withTempRepo(async (repo) => {
    const { runId: fromRun, keys } = await trioRunInto(repo.dir);
    expect(keys).toEqual(TRIO_JOURNAL);
    const end = await seeded(repo, fromRun, 'a');
    expect(endOf(end)).toEqual({ status: 'suspended', stopReason: 'until' });
    const dir = dirOf(end);
    expect(journaled(dir)).toEqual(['intake#1 passed', 'b#1 done', 'c#1 done', 'a#1 done']);
    expect(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).fromRun).toBe(fromRun);
    expect(
      readEvents(dir)
        .filter((event) => event.type === 'stage:start')
        .map((event) => event.key),
    ).toEqual(['a#1', 'b#1', 'c#1']);
  });
  await withTempRepo(async (repo) => {
    const { runId: fromRun, keys } = await trioRunInto(repo.dir);
    expect(keys).toEqual(TRIO_JOURNAL);
    const end = await seeded(repo, fromRun, 'b', { continue: true });
    expect(endOf(end)).toEqual({ status: 'completed', stopReason: undefined });
    expect(journaled(dirOf(end))).toEqual(['intake#1 passed', 'b#1 done', 'c#1 done', 'a#1 done', 'd#1 done']);
  });
}, 90_000);

test('a seeded run whose workflow now asks for a group without the stage it was seeded for fails with determinism_violation, and runs nothing', async () => {
  await withTempRepo(async (repo) => {
    const { runId: fromRun, keys } = await trioRunInto(repo.dir);
    expect(keys).toEqual(TRIO_JOURNAL);
    edit(
      join(repo.dir, '.sail'),
      `workflows/${TRIO}/workflow.ts`,
      TRIO_GROUP,
      '  const results = await run.all([[a, { brief }], [c, { brief }]]);\n',
    );
    const end = await seeded(repo, fromRun, 'b');
    expect(endOf(end)).toEqual({ status: 'failed', stopReason: 'determinism_violation' });
    expect('refused' in end ? '' : end.message).toBe(
      `the workflow asks for the group a#1, c#1 after the calls reused from run ${fromRun}, not b#1: it changed since that run`,
    );
    expect(journaled(dirOf(end))).toEqual(['intake#1 passed']);
  });
}, 60_000);

test("a run seeded for the stage after a two-step call reuses the call's step lines with its own, as reused calls, and validates", async () => {
  await withTempRepo(async (repo) => {
    const fromRun = await withTempRepo(async (from) => {
      writeTwoStep(from.dir);
      const end = await runWorkflow({
        cwd: from.dir,
        adapters: await fakeAdapters(from.dir),
        workflow: AGENT_WORKFLOW,
        ticket: 'FAKE-1',
      });
      if ('refused' in end) throw new Error(end.refused);
      copyRun(from.dir, repo.dir);
      return end.runId;
    });
    // notify is the workflow's last call, so the run ends once it has run.
    const end = await seeded(repo, fromRun, 'notify');
    expect(endOf(end)).toEqual({ status: 'completed', stopReason: undefined });
    const dir = dirOf(end);
    const reused = readEvents(dir).flatMap((event) =>
      event.type === 'journal:append' && event.fromRun !== undefined ? [event.key] : [],
    );
    const summary: Summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    expect({
      journal: journaled(dir),
      reused,
      calls: summary.calls.map(({ key, fromRun }) => (fromRun === undefined ? key : `${key} reused`)),
      issues: issuesOf(dir),
    }).toEqual({
      journal: [
        'intake#1 passed',
        'brief#1 passed',
        'spec#1 done',
        'publish#1/describe done',
        'publish#1/open passed',
        'publish#1 passed',
        'notify#1 passed',
      ],
      reused: ['intake#1', 'brief#1', 'spec#1', 'publish#1/describe', 'publish#1/open', 'publish#1'],
      calls: ['intake#1 reused', 'brief#1 reused', 'spec#1 reused', 'publish#1 reused', 'notify#1'],
      issues: [],
    });
  });
}, 90_000);
