// stopRun() (DECISIONS D7): a run nothing runs, suspended or running with its process gone, ends `failed stopped` at
// once, its workspace and lease released and `run:end` closing its stream; a run whose lease another run took over ends
// the same way with no lease to release. On the stub workflow and the fake adapters, one run per temp repository.
import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RunEnd, resumeWorkflow, runWorkflow } from '../../src/engine/runtime';
import { validateRunDir } from '../../src/engine/schemas';
import { stopRun } from '../../src/engine/stop';
import { fakeAdapters } from '../helpers/adapters';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

/** The stub's run of FAKE-1 in `repo`, suspended with `until` after `spec#1`. */
async function suspendedRun(repo: TempRepo): Promise<RunEnd> {
  writeStub(repo.dir);
  const end = await runWorkflow({
    cwd: repo.dir,
    adapters: await fakeAdapters(repo.dir),
    workflow: 'ticket-to-pr',
    ticket: 'FAKE-1',
    until: 'spec',
  });
  if ('refused' in end) throw new Error(end.refused);
  if (end.status !== 'suspended') throw new Error(`the run ended ${end.status}`);
  return end;
}

const stop = async (repo: TempRepo, runId: string) =>
  stopRun({ sailDir: join(repo.dir, '.sail'), runId, adapters: await fakeAdapters(repo.dir) });

/** The run's events, parsed. */
const events = (dir: string): Record<string, unknown>[] =>
  readFileSync(join(dir, 'events.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));

const leasesDir = (repo: TempRepo) => join(repo.dir, '.sail-runs', 'fake', 'leases');
/** The lease files the fake workspace keeps. */
const leaseFiles = (repo: TempRepo): string[] =>
  existsSync(leasesDir(repo)) ? readdirSync(leasesDir(repo)).filter((name) => name.endsWith('.json')) : [];

/** What a stopped run's directory and lease say. */
function stoppedState(repo: TempRepo, end: RunEnd) {
  const summary = JSON.parse(readFileSync(join(end.dir, 'summary.json'), 'utf8'));
  return {
    status: readFileSync(join(end.dir, 'STATUS'), 'utf8'),
    summary: [summary.status, summary.stopReason],
    workspace: existsSync(join(end.dir, 'workspace')),
    leases: leaseFiles(repo),
    issues: validateRunDir(end.dir).issues,
  };
}

/** What a stopped run's directory and lease say once it is stopped: no worktree, and no lease left. */
const STOPPED = {
  status: 'failed stopped\n',
  summary: ['failed', 'stopped'],
  workspace: false,
  leases: [],
  issues: [],
};

test('a suspended run stopped ends failed stopped: STATUS, run:end last with the next seq, summary.json final, its worktree and lease gone, and a resume refused', async () => {
  await withTempRepo(async (repo) => {
    const end = await suspendedRun(repo);
    const before = events(end.dir);
    const stopped = await stop(repo, end.runId);
    const after = events(end.dir);
    expect(stopped).toEqual({
      ended: {
        runId: end.runId,
        dir: end.dir,
        status: 'failed',
        stopReason: 'stopped',
        message: 'stopped by sail stop',
      },
    });
    expect({
      added: after.slice(before.length).map((event) => event.type),
      last: after.at(-1),
      ...stoppedState(repo, end),
    }).toEqual({
      added: ['workspace:leased', 'workspace:released', 'workspace:lease_released', 'run:end'],
      last: {
        seq: before.length + 4,
        ts: expect.any(String),
        type: 'run:end',
        runId: end.runId,
        status: 'failed',
        stopReason: 'stopped',
        message: 'stopped by sail stop',
        replays: 0,
      },
      ...STOPPED,
    });
    expect(await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId: end.runId })).toEqual({
      refused: `run ${end.runId} failed (stopped): a failed run is final`,
    });
  });
});

test('a run left running by a process that is gone is stopped the same way, its torn last event cut first', async () => {
  await withTempRepo(async (repo) => {
    const end = await suspendedRun(repo);
    writeFileSync(join(end.dir, 'STATUS'), 'running\n');
    const [file] = leaseFiles(repo);
    const lease = JSON.parse(readFileSync(join(leasesDir(repo), file ?? ''), 'utf8'));
    const ended = Bun.spawnSync(['true']).pid;
    writeFileSync(join(leasesDir(repo), file ?? ''), `${JSON.stringify({ ...lease, pid: ended })}\n`);
    const complete = events(end.dir).length;
    appendFileSync(join(end.dir, 'events.ndjson'), '{"seq":');
    const stopped = await stop(repo, end.runId);
    expect(stopped).toMatchObject({ ended: { status: 'failed', stopReason: 'stopped' } });
    const after = events(end.dir);
    expect({ seqs: after.map((event) => event.seq), ...stoppedState(repo, end) }).toEqual({
      seqs: Array.from({ length: complete + 4 }, (_, index) => index + 1),
      ...STOPPED,
    });
  });
});

test('a run whose lease another run took over is stopped with no lease to release, and the other run keeps its lease', async () => {
  await withTempRepo(async (repo) => {
    const end = await suspendedRun(repo);
    const [file] = leaseFiles(repo);
    const path = join(leasesDir(repo), file ?? '');
    const lease = JSON.parse(readFileSync(path, 'utf8'));
    const other = {
      ...lease,
      runId: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N',
      runDir: join(repo.dir, '.sail-runs', 'other'),
      pid: process.pid,
    };
    writeFileSync(path, `${JSON.stringify(other)}\n`);
    const before = events(end.dir).length;
    const stopped = await stop(repo, end.runId);
    expect(stopped).toMatchObject({ ended: { status: 'failed', stopReason: 'stopped' } });
    expect({
      added: events(end.dir)
        .slice(before)
        .map((event) => event.type),
      lease: JSON.parse(readFileSync(path, 'utf8')),
      status: readFileSync(join(end.dir, 'STATUS'), 'utf8'),
      workspace: existsSync(join(end.dir, 'workspace')),
      issues: validateRunDir(end.dir).issues,
    }).toEqual({
      added: ['workspace:released', 'run:end'],
      lease: other,
      status: 'failed stopped\n',
      workspace: false,
      issues: [],
    });
  });
});
