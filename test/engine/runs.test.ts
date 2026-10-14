// listRuns() and resolveRun(): the runs in `.sail-runs/`, beside a `.sail/` with nothing in it. A directory without
// run.json, like the one `sail stage run` writes, is never a run.
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRuns, resolveRun } from '../../src/engine/runs';
import { copyGoldenRun, emptySailDir, GOLDEN_RUN_ID } from '../helpers/golden-run';
import { withTempRepo } from '../helpers/temp-repo';

const STAGE_RUN = 'tests-01M3D4A2B6C8E0G2J4K6M8P0R2';

/** A run directory `.sail-runs/<id>/` that holds a run.json, which is all resolveRun looks for. */
function runNamed(repoDir: string, id: string): void {
  mkdirSync(join(repoDir, '.sail-runs', id), { recursive: true });
  writeFileSync(join(repoDir, '.sail-runs', id, 'run.json'), '{}\n');
}

const MANY = ['MANY-1', 'MANY-2', 'MANY-3', 'MANY-4', 'MANY-5', 'MANY-6', 'MANY-7'];
const FAKE_2 = 'FAKE-2-01M3C0Q5ZJ3K8T1V9XRJ5KWD3P';

test.each<[string, string, string | undefined]>([
  ['an exact id', GOLDEN_RUN_ID, GOLDEN_RUN_ID],
  ['a prefix only one run starts with', 'FAKE-2', FAKE_2],
  ['an exact id that also starts another', 'FAKE-7-1', 'FAKE-7-1'],
  ['a prefix of no run', 'NOPE', undefined],
  ['a prefix of a directory without run.json', 'tests', undefined],
  ['the whole name of a directory without run.json', STAGE_RUN, undefined],
])('resolveRun given %s finds the run it names, or refuses with no match', (_, name, runId) => {
  return withTempRepo((repo) => {
    const sail = emptySailDir(repo.dir);
    for (const id of [GOLDEN_RUN_ID, FAKE_2, 'FAKE-7-1', 'FAKE-7-10']) runNamed(repo.dir, id);
    mkdirSync(join(repo.dir, '.sail-runs', STAGE_RUN, '00-tests', 'call-1'), { recursive: true });
    expect(resolveRun(sail, name)).toEqual(
      runId === undefined
        ? { refused: `no run matching '${name}' in .sail-runs` }
        : { runId, dir: join(repo.dir, '.sail-runs', runId) },
    );
  });
});

test.each([
  ['FAKE', `'FAKE' matches 2 runs: ${GOLDEN_RUN_ID}, ${FAKE_2}`],
  ['MANY', "'MANY' matches 7 runs: MANY-1, MANY-2, MANY-3, MANY-4, MANY-5 and 2 more"],
  ['../x', "'../x' is not a run id"],
])('resolveRun refuses %p', (name, refused) => {
  return withTempRepo((repo) => {
    const sail = emptySailDir(repo.dir);
    for (const id of [FAKE_2, ...[...MANY].reverse(), GOLDEN_RUN_ID]) runNamed(repo.dir, id);
    expect(resolveRun(sail, name)).toEqual({ refused });
  });
});

const EARLIEST = 'FAKE-3-01M3A7H2KQ9V4T6V2XRJ5KWD3M';
const SAME_START = 'FAKE-0-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const WORKFLOW = 'ticket-to-pr@1';
const GOLDEN_START = '2026-09-25T09:00:00.000Z';

test('listRuns gives the runs that hold run.json, oldest first and then by id, with their workflow, start and status', () => {
  return withTempRepo((repo) => {
    const sail = emptySailDir(repo.dir);
    expect(listRuns(sail)).toEqual([]);
    copyGoldenRun(repo.dir, { status: 'completed\n' });
    copyGoldenRun(repo.dir, {
      runId: FAKE_2,
      startedAt: '2026-09-26T10:30:15.250Z',
      status: 'suspended interrupted\n',
    });
    copyGoldenRun(repo.dir, {
      runId: EARLIEST,
      startedAt: '2026-09-24T08:05:09.999Z',
      status: 'failed workflow_failed\n',
    });
    copyGoldenRun(repo.dir, { runId: SAME_START, status: 'running\n' });
    mkdirSync(join(repo.dir, '.sail-runs', STAGE_RUN), { recursive: true });
    const dir = (id: string) => join(repo.dir, '.sail-runs', id);
    expect(listRuns(sail)).toEqual([
      {
        runId: EARLIEST,
        dir: dir(EARLIEST),
        workflow: WORKFLOW,
        startedAt: '2026-09-24T08:05:09.999Z',
        status: { status: 'failed', stopReason: 'workflow_failed' },
      },
      {
        runId: SAME_START,
        dir: dir(SAME_START),
        workflow: WORKFLOW,
        startedAt: GOLDEN_START,
        status: { status: 'running' },
      },
      {
        runId: GOLDEN_RUN_ID,
        dir: dir(GOLDEN_RUN_ID),
        workflow: WORKFLOW,
        startedAt: GOLDEN_START,
        status: { status: 'completed' },
      },
      {
        runId: FAKE_2,
        dir: dir(FAKE_2),
        workflow: WORKFLOW,
        startedAt: '2026-09-26T10:30:15.250Z',
        status: { status: 'suspended', stopReason: 'interrupted' },
      },
    ]);
  });
});

test("a run whose run.json or STATUS can't be read is listed with its problem, and one with no start goes last", () => {
  return withTempRepo((repo) => {
    const sail = emptySailDir(repo.dir);
    const noHeader = copyGoldenRun(repo.dir, { runId: 'FAKE-0-01M3BWNZM08Q4T6V2XRJ5KWD3N', status: 'completed\n' });
    writeFileSync(join(noHeader, 'run.json'), '{');
    copyGoldenRun(repo.dir, { runId: FAKE_2, status: 'bogus\n' });
    copyGoldenRun(repo.dir, { status: 'completed\n' });
    expect(listRuns(sail)).toEqual([
      {
        runId: GOLDEN_RUN_ID,
        dir: join(repo.dir, '.sail-runs', GOLDEN_RUN_ID),
        workflow: WORKFLOW,
        startedAt: GOLDEN_START,
        status: { status: 'completed' },
      },
      {
        runId: FAKE_2,
        dir: join(repo.dir, '.sail-runs', FAKE_2),
        workflow: WORKFLOW,
        startedAt: GOLDEN_START,
        problem: expect.stringContaining('STATUS'),
      },
      {
        runId: 'FAKE-0-01M3BWNZM08Q4T6V2XRJ5KWD3N',
        dir: noHeader,
        status: { status: 'completed' },
        problem: expect.stringContaining('run.json'),
      },
    ]);
  });
});
