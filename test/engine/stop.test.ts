// stopRun() (DECISIONS D7): a run nothing runs, suspended or running with its process gone, ends `failed stopped` at
// once, its workspace and lease released and `run:end` closing its stream; a run whose lease another run took over ends
// the same way with no lease to release. On the stub workflow and the fake adapters, one run per temp repository.
import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RunEnd, resumeWorkflow, runWorkflow } from '../../src/engine/runtime';
import { validateRunDir } from '../../src/engine/schemas';
import { stopRun } from '../../src/engine/stop';
import { PortError } from '../../src/ports/errors';
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

test('an immediate stop on a live run writes stopped now and returns its pid', async () => {
  await withTempRepo(async (repo) => {
    const end = await suspendedRun(repo);
    const adapters = await fakeAdapters(repo.dir);
    const lease = adapters.ports.workspace.lease.bind(adapters.ports.workspace);
    adapters.ports.workspace.lease = async (...args) => {
      await lease(...args);
      return {
        leased: false,
        holder: {
          runId: end.runId,
          runDir: end.dir,
          pid: 12345,
          remote: args[0],
          branch: args[1],
          takenAt: '2026-10-01T12:00:00.000Z',
        },
        raw: null,
      };
    };
    const stopped = await stopRun({ sailDir: join(repo.dir, '.sail'), runId: end.runId, adapters, now: true });
    expect(stopped).toEqual({ requested: { pid: 12345, now: true } });
    expect(readFileSync(join(end.dir, 'CONTROL'), 'utf8')).toBe('stopped now\n');
  });
});

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

test('a stopped run that committed in its workspace keeps its commits at refs/sail/runs/<runId>, which workspace:released records', async () => {
  await withTempRepo(async (repo) => {
    const end = await suspendedRun(repo);
    repo.git('-C', join(end.dir, 'workspace'), 'commit', '-q', '--allow-empty', '-m', 'work');
    const head = repo.git('-C', join(end.dir, 'workspace'), 'rev-parse', 'HEAD');
    const stopped = await stop(repo, end.runId);
    const ref = `refs/sail/runs/${end.runId}`;
    expect({
      message: 'ended' in stopped ? stopped.ended.message : stopped,
      released: events(end.dir).find((event) => event.type === 'workspace:released')?.ref,
      kept: repo.git('rev-parse', ref),
      ...stoppedState(repo, end),
    }).toEqual({
      message: 'stopped by sail stop',
      released: ref,
      kept: head,
      ...STOPPED,
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

test("a stopped run's events and summary mask a credential a release's error carries", async () => {
  await withTempRepo(async (repo) => {
    const end = await suspendedRun(repo);
    const secret = 'ghp_STOP_MARKER_4b2e9d';
    const adapters = await fakeAdapters(repo.dir);
    const workspace = adapters.ports.workspace;
    adapters.ports.workspace = Object.assign(Object.create(workspace), {
      release: () =>
        Promise.reject(new PortError('workspace', 'release', 'unavailable', `denied https://x:${secret}@h/r`)),
    });
    const stopped = await stopRun({ sailDir: join(repo.dir, '.sail'), runId: end.runId, adapters, secrets: [secret] });
    expect(stopped).toMatchObject({ ended: { status: 'failed', stopReason: 'stopped' } });
    expect({
      events: readFileSync(join(end.dir, 'events.ndjson'), 'utf8').includes(secret),
      summary: readFileSync(join(end.dir, 'summary.json'), 'utf8').includes(secret),
      message: events(end.dir).at(-1)?.message,
    }).toEqual({
      events: false,
      summary: false,
      message:
        'stopped by sail stop; its workspace was not released: workspace.release: denied https://x:[redacted]@h/r',
    });
  });
});

// A dispatched run that is still starting has no run.json: `starting` says it is one, and the stop waits for it.

const STARTING = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';

test('stopRun of a run with no run.json that starting vouches for writes its hand-off, or CONTROL once its directory exists', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const runs = join(repo.dir, '.sail-runs');
    mkdirSync(runs, { recursive: true });
    const sailDir = join(repo.dir, '.sail');
    const starting = async () =>
      stopRun({ sailDir, runId: STARTING, adapters: await fakeAdapters(repo.dir), starting: () => true });
    const first = await starting();
    const handOff = readFileSync(join(runs, `${STARTING}.control`), 'utf8');
    mkdirSync(join(runs, STARTING));
    const second = await starting();
    expect({
      first,
      handOff,
      second,
      control: readFileSync(join(runs, STARTING, 'CONTROL'), 'utf8'),
      left: existsSync(join(runs, `${STARTING}.control`)),
    }).toEqual({
      first: { starting: true },
      handOff: 'stopped\n',
      second: { starting: true },
      control: 'stopped\n',
      left: false,
    });
  });
});

test.each<[string, Partial<Parameters<typeof stopRun>[0]>]>([
  ['no starting check', {}],
  ['a starting check that says no', { starting: () => false }],
])('stopRun of a run with no run.json is refused and writes nothing with %s', async (_, extra) => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const runs = join(repo.dir, '.sail-runs');
    mkdirSync(runs, { recursive: true });
    const stopped = await stopRun({
      sailDir: join(repo.dir, '.sail'),
      runId: STARTING,
      adapters: await fakeAdapters(repo.dir),
      ...extra,
    });
    expect([stopped, readdirSync(runs)]).toEqual([{ refused: `no run '${STARTING}' in .sail-runs` }, []]);
  });
});
