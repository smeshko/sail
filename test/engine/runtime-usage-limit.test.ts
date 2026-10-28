// A run whose agent call hits the provider's usage limit (runtime.ts): the fixture's ticket-to-pr on the fake harness,
// one answer of which is a `usage_limit` error. The run is suspended with `usage_limit`, not failed: the limited call is
// left unjournaled, the workspace and the lease are kept, and a resume runs the call again as its next try. Each case
// has a temp repository of its own, and a resume runs in a copy of the repository the run was suspended in (copyRun()).
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessScript, ScriptedAnswer } from '../../src/adapters/fake/harness';
import { readJournal } from '../../src/engine/journal';
import { type RunEnd, resumeWorkflow, runWorkflow } from '../../src/engine/runtime';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { SailEvent } from '../../src/events/types';
import { fakeAdapters } from '../helpers/adapters';
import { writeHarnessScript } from '../helpers/agent-fixture';
import { copyFixture } from '../helpers/fixture';
import { TRIO, writeTrio } from '../helpers/review-fixture';
import { copyRun } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const RESETS_AT = '2026-10-28T14:20:00.000Z';
const MESSAGE = "You've hit your session limit · resets 4:20pm (Europe/Sofia)";
const LIMIT: ScriptedAnswer = { outcome: 'error', reason: 'usage_limit', message: MESSAGE, resetsAt: RESETS_AT };

/** The fixture's harness script, read from the copy in `repoDir`. */
const scriptIn = (repoDir: string): HarnessScript =>
  JSON.parse(readFileSync(join(repoDir, '.sail', 'fake', 'harness.json'), 'utf8')) as HarnessScript;

/** Runs `workflow` from `cwd` on `FAKE-1`, on the fakes. It must not be refused. */
async function ran(cwd: string, workflow = 'ticket-to-pr'): Promise<RunEnd> {
  const end = await runWorkflow({ cwd, adapters: await fakeAdapters(cwd), workflow, ticket: 'FAKE-1' });
  if ('refused' in end) throw new Error(`refused: ${end.refused}`);
  return end;
}

/** Resumes run `runId` from `cwd` on the fakes. It must not be refused. */
async function resumed(cwd: string, runId: string): Promise<RunEnd> {
  const end = await resumeWorkflow({ cwd, runId, adapters: await fakeAdapters(cwd) });
  if ('refused' in end) throw new Error(`refused: ${end.refused}`);
  return end;
}

const keys = (runDir: string) => readJournal(runDir).entries.map((entry) => entry.key);
const status = (runDir: string) => readFileSync(join(runDir, 'STATUS'), 'utf8');
const bare = ({ seq: _s, ts: _t, runId: _r, ...rest }: SailEvent) => rest;
const leasesIn = (repoDir: string) => {
  const dir = join(repoDir, '.sail-runs', 'fake', 'leases');
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** The fixture with `answers` as the first answers of `stage`, then its own. */
function limitedAt(repoDir: string, stage: string): void {
  copyFixture(repoDir);
  const script = scriptIn(repoDir);
  script[stage] = [LIMIT, ...(script[stage] ?? [])];
  writeHarnessScript(repoDir, script);
}

test('a run whose spec#1 hits the usage limit ends suspended usage_limit: run:suspended names the call and the reset time, then run:end, and spec#1 is not journaled', async () => {
  await withTempRepo(async (repo) => {
    limitedAt(repo.dir, 'spec');
    const end = await ran(repo.dir);
    const list = readEvents(end.dir);
    const at = list.findIndex((event) => event.type === 'run:suspended');
    expect({
      end: { status: end.status, stopReason: end.stopReason, message: end.message },
      status: status(end.dir),
      trail: list.slice(at).map(bare),
      journal: keys(end.dir),
      journaledSpec: list.some((event) => event.type === 'journal:append' && event.key === 'spec#1'),
    }).toEqual({
      end: {
        status: 'suspended',
        stopReason: 'usage_limit',
        message: `spec#1 hit the usage limit: it resets at ${RESETS_AT}`,
      },
      status: 'suspended usage_limit\n',
      trail: [
        { type: 'run:suspended', stopReason: 'usage_limit', key: 'spec#1', resetsAt: RESETS_AT },
        {
          type: 'run:end',
          status: 'suspended',
          stopReason: 'usage_limit',
          message: `spec#1 hit the usage limit: it resets at ${RESETS_AT}`,
          replays: 1,
        },
      ],
      journal: ['intake#1'],
      journaledSpec: false,
    });
  });
});

test("the limited call's result.json lists the usage_limit error with the reset time, and the suspended run keeps its workspace and its lease", async () => {
  await withTempRepo(async (repo) => {
    limitedAt(repo.dir, 'spec');
    const end = await ran(repo.dir);
    const list = readEvents(end.dir);
    const ended = list.find((event) => event.type === 'stage:end' && event.key === 'spec#1');
    if (ended?.type !== 'stage:end') throw new Error('no stage:end for spec#1');
    const result = JSON.parse(readFileSync(join(end.dir, ended.resultPath), 'utf8')) as { errors: unknown };
    expect({
      errors: result.errors,
      released: list.filter(
        (event) => event.type === 'workspace:released' || event.type === 'workspace:lease_released',
      ),
      workspace: existsSync(join(end.dir, 'workspace', '.git')),
      leases: leasesIn(repo.dir).length,
    }).toEqual({
      errors: [{ reason: 'usage_limit', message: MESSAGE, resetsAt: RESETS_AT }],
      released: [],
      workspace: true,
      leases: 1,
    });
  });
});

test('a resume of a usage-limited run runs spec#1 again as its second try, journals it, and completes', async () => {
  await withTempRepo(async (from) => {
    limitedAt(from.dir, 'spec');
    const suspended = await ran(from.dir);
    await withTempRepo(async (repo) => {
      copyRun(from.dir, repo.dir);
      const dir = join(repo.dir, '.sail-runs', suspended.runId);
      const before = readEvents(dir).length;
      const end = await resumed(repo.dir, suspended.runId);
      const after = readEvents(dir).slice(before);
      expect({
        status: end.status,
        spec: after.find((event) => event.type === 'stage:start' && event.key === 'spec#1'),
        journaled: after.find((event) => event.type === 'journal:append' && event.key === 'spec#1'),
        journal: keys(dir),
        final: status(dir),
      }).toEqual({
        status: 'completed',
        spec: expect.objectContaining({ try: 2 }),
        journaled: expect.objectContaining({ outcome: 'done' }),
        journal: expect.arrayContaining(['intake#1', 'spec#1', 'publish#1']),
        final: 'completed\n',
      });
    });
  });
});

test('a limit without a reset time suspends the run with no resetsAt on run:suspended', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const script = scriptIn(repo.dir);
    script.spec = [{ outcome: 'error', reason: 'usage_limit', message: MESSAGE }];
    writeHarnessScript(repo.dir, script);
    const end = await ran(repo.dir);
    expect({
      message: end.message,
      suspended: readEvents(end.dir)
        .filter((event) => event.type === 'run:suspended')
        .map(bare),
    }).toEqual({
      message: 'spec#1 hit the usage limit',
      suspended: [{ type: 'run:suspended', stopReason: 'usage_limit', key: 'spec#1' }],
    });
  });
});

test("a multi-step stage's step that hits the usage limit stops the call unjournaled, and a resume runs the step again", async () => {
  await withTempRepo(async (from) => {
    limitedAt(from.dir, 'publish/describe');
    const suspended = await ran(from.dir);
    const list = readEvents(suspended.dir);
    expect({
      stopReason: suspended.stopReason,
      suspended: list.filter((event) => event.type === 'run:suspended').map(bare),
      journal: keys(suspended.dir).filter((key) => key.startsWith('publish')),
    }).toEqual({
      stopReason: 'usage_limit',
      suspended: [{ type: 'run:suspended', stopReason: 'usage_limit', key: 'publish#1', resetsAt: RESETS_AT }],
      journal: [],
    });
    await withTempRepo(async (repo) => {
      copyRun(from.dir, repo.dir);
      const end = await resumed(repo.dir, suspended.runId);
      const dir = join(repo.dir, '.sail-runs', suspended.runId);
      expect({ status: end.status, journal: keys(dir).filter((key) => key.startsWith('publish')) }).toEqual({
        status: 'completed',
        journal: ['publish#1/describe', 'publish#1/open', 'publish#1'],
      });
    });
  });
});

test('in a group, a member that hits the usage limit is left unjournaled while the members that passed are journaled, and the run is suspended', async () => {
  await withTempRepo(async (from) => {
    writeTrio(from.dir, { a: 40, b: 0, c: 40 });
    const script = scriptIn(from.dir);
    script.b = [LIMIT, ...(script.b ?? [])];
    writeHarnessScript(from.dir, script);
    const suspended = await ran(from.dir, TRIO);
    const list = readEvents(suspended.dir);
    expect({
      status: suspended.status,
      stopReason: suspended.stopReason,
      journal: keys(suspended.dir).sort(),
      suspended: list.filter((event) => event.type === 'run:suspended').map(bare),
      groupEnded: list.some((event) => event.type === 'all:end'),
    }).toEqual({
      status: 'suspended',
      stopReason: 'usage_limit',
      journal: ['a#1', 'c#1', 'intake#1'],
      suspended: [{ type: 'run:suspended', stopReason: 'usage_limit', key: 'b#1', resetsAt: RESETS_AT }],
      groupEnded: false,
    });
    await withTempRepo(async (repo) => {
      copyRun(from.dir, repo.dir);
      const end = await resumed(repo.dir, suspended.runId);
      const dir = join(repo.dir, '.sail-runs', suspended.runId);
      expect({ status: end.status, journal: keys(dir).sort() }).toEqual({
        status: 'completed',
        journal: ['a#1', 'b#1', 'c#1', 'd#1', 'intake#1'],
      });
    });
  });
});
