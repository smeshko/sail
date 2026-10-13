// A run in its own worktree, in process through runWorkflow(): its lease reported in the stream (TASK-006), its calls run
// with the worktree as WORKSPACE (TASK-007), and its worktree and lease released when it ends, or kept when it is
// suspended (TASK-008). Each case has a temp repository and HOME, so its leases are its own.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readLease } from '../../src/adapters/leases';
import { type RunEnd, type RunWorkflowOptions, runWorkflow } from '../../src/engine/runtime';
import { readEvents } from '../../src/events/consumers/ndjson';
import { fakeAdapters } from '../helpers/adapters';
import { type StubOptions, writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

/** The stub's ticket-to-pr, run from `repo` on `FAKE-1` under the repository's own HOME, which must not be refused. */
async function runIn(repo: TempRepo, options: Partial<RunWorkflowOptions> = {}): Promise<RunEnd> {
  const end = await runWorkflow({
    cwd: repo.dir,
    adapters: await fakeAdapters(repo.dir, repo.env),
    workflow: 'ticket-to-pr',
    ticket: 'FAKE-1',
    ...options,
  });
  if ('refused' in end) throw new Error(`refused: ${end.refused}`);
  return end;
}

/** The stub repository, with `options`, in a temp repository of its own. */
async function withStub(options: StubOptions, check: (repo: TempRepo) => Promise<void>): Promise<void> {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, options);
    await check(repo);
  });
}

/** What the released and ended events of a run say: its worktree's `kept` flag, and where each sits in the stream. */
function endOf(dir: string) {
  const types = readEvents(dir).map((event) => event.type);
  const released = readEvents(dir).find((event) => event.type === 'workspace:released') as
    | { kept?: boolean }
    | undefined;
  return {
    kept: released?.kept,
    releasedBeforeEnd: types.indexOf('workspace:released') < types.indexOf('run:end'),
    leaseReleasedBeforeEnd: types.indexOf('workspace:lease_released') < types.indexOf('run:end'),
  };
}

// STICKER: each case below is one of ADW-93's TASK-006 to TASK-008. The sticker names the task that makes it pass.

test('a fresh run reports its lease right after run:start, before what the claim did', async () => {
  await withStub({}, async (repo) => {
    const end = await runIn(repo);
    expect(
      readEvents(end.dir)
        .slice(0, 4)
        .map((event) => event.type),
    ).toEqual(['run:start', 'workspace:leased', 'ticket:claimed', 'ticket:commented']);
  });
});

test("every call of a run runs in the run's worktree: each call's log line names it as WORKSPACE, and the clone holds no .stub", async () => {
  await withStub({}, async (repo) => {
    const end = await runIn(repo, { until: 'tests' });
    const worktree = realpathSync(join(end.dir, 'workspace'));
    const logs = join(repo.dir, '.stub-log');
    const lines = readdirSync(logs)
      .sort()
      .flatMap((file) => readFileSync(join(logs, file), 'utf8').trim().split('\n'))
      .map((line) => line.split(' '));
    expect({
      calls: lines.map(([call]) => call),
      inWorktree: lines.map(([, dir]) => realpathSync(dir ?? '') === worktree),
      cloneHasStub: existsSync(join(repo.dir, '.stub')),
    }).toEqual({
      calls: ['spec#1', 'implement#1', 'tests#1'],
      inWorktree: [true, true, true],
      cloneHasStub: false,
    });
  });
});

test('a completed run removes its worktree and releases its lease, both before run:end', async () => {
  await withStub({}, async (repo) => {
    const end = await runIn(repo);
    expect({
      status: end.status,
      worktreeGone: !existsSync(join(end.dir, 'workspace')),
      ...endOf(end.dir),
    }).toEqual({
      status: 'completed',
      worktreeGone: true,
      kept: false,
      releasedBeforeEnd: true,
      leaseReleasedBeforeEnd: true,
    });
  });
});

test('a failed run removes its worktree and releases its lease, both before run:end', async () => {
  await withStub({ testsPassAt: 99 }, async (repo) => {
    const end = await runIn(repo);
    expect({
      status: end.status,
      worktreeGone: !existsSync(join(end.dir, 'workspace')),
      ...endOf(end.dir),
    }).toEqual({
      status: 'failed',
      worktreeGone: true,
      kept: false,
      releasedBeforeEnd: true,
      leaseReleasedBeforeEnd: true,
    });
  });
});

test('a suspended run keeps its worktree and its lease, and its workspace:released says kept', async () => {
  await withStub({}, async (repo) => {
    const end = await runIn(repo, { until: 'tests' });
    const lease = readLease(join(repo.home, '.sail', 'leases'), 'fake', 'sail/FAKE-1');
    expect({
      status: end.status,
      worktreeKept: existsSync(join(end.dir, 'workspace')),
      kept: endOf(end.dir).kept,
      leasedBy: lease?.runId,
    }).toEqual({ status: 'suspended', worktreeKept: true, kept: true, leasedBy: end.runId });
  });
});
