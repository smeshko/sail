// A person's Resume and Restart, end to end: the dashboard server starts the real `sail` detached in a repository of the
// fixture workflow, and the run it starts goes on after the dashboard stops. `sail FAKE-1 --until spec` suspends a run;
// a POST to resume it finishes it. Then its STATUS is made `failed`, and a POST to restart it from spec starts a seeded
// run under a new id, whose run.json names the run it was seeded from. The seeded run, made suspended, is stopped from the
// dashboard, and the failed one is cleaned: its branch and run directory go, and the archive holds the directory.
// Each action waits for the run's closing `run:end`, which follows the release of its workspace and lease.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { startDashboard } from '../../src/dashboard/server';
import { isRunIdOf } from '../../src/engine/run-id';
import { readEvents } from '../../src/events/consumers/ndjson';
import { machineDir, readRegistry, registryDir } from '../../src/watch/registry';
import { copyFixture } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { sailProcess } from '../helpers/sail-process';
import { heldRuns, setHoldAt, writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const POST = { 'X-Sail-Dashboard': '1', 'Content-Type': 'application/json' };

const statusOf = (dir: string) => readFileSync(join(dir, 'STATUS'), 'utf8').trim();

/** Whether the last `run:end` of the run's events says `completed`: the process has let go of its workspace and lease. */
const endedCompleted = (dir: string) => {
  const ends = readEvents(dir).filter((event) => event.type === 'run:end');
  return (ends.at(-1) as { status?: string } | undefined)?.status === 'completed';
};

async function until(what: string, holds: () => boolean, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(100);
  }
}

test('a suspended run resumes to completion from the dashboard, and a failed one restarts as a seeded run from a stage it ran, then it is stopped and the failed one cleaned', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    // A machine directory of its own: an in-process run finds the default one through the test process's HOME, which
    // the other test files of the process share, and whose entry for the fixture's name another clone may take.
    const env = { ...repo.env, SAIL_HOME: join(repo.home, '.sail') };
    const ran = await runCaptured(['FAKE-1', '--until', 'spec'], repo.dir, { env });
    expect(ran.code).toBe(EXIT_SUSPENDED);
    const runs = join(repo.dir, '.sail-runs');
    const [runId = ''] = readdirSync(runs).filter((name) => isRunIdOf('FAKE-1', name));
    const dir = join(runs, runId);
    expect(statusOf(dir)).toStartWith('suspended');

    const registry = registryDir(machineDir(env));
    const { name = '' } = readRegistry(registry).entries.find((entry) => entry.clone === repo.dir) ?? {};
    const started = startDashboard({ registryDir: registry, port: 0, env });
    if ('refused' in started) throw new Error(started.refused);
    try {
      const base = `http://127.0.0.1:${started.port}/api/repos/${name}/runs`;
      const resumed = await fetch(`${base}/${runId}/resume`, { method: 'POST', headers: POST, body: '{}' });
      expect([resumed.status, await resumed.json()]).toEqual([202, { runId }]);
      await until('the resumed run to end', () => statusOf(dir) === 'completed' && endedCompleted(dir));

      writeFileSync(join(dir, 'STATUS'), 'failed stage_error\n');
      const restarted = await fetch(`${base}/${runId}/restart`, {
        method: 'POST',
        headers: POST,
        body: '{"stage":"spec"}',
      });
      const { runId: seeded } = (await restarted.json()) as { runId: string };
      expect(restarted.status).toBe(202);
      expect(seeded).not.toBe(runId);
      expect(isRunIdOf('FAKE-1', seeded)).toBe(true);
      expect(JSON.parse(readFileSync(join(runs, seeded, 'run.json'), 'utf8')).fromRun).toBe(runId);
      await until(
        'the seeded run to end',
        () => statusOf(join(runs, seeded)) === 'completed' && endedCompleted(join(runs, seeded)),
      );
      expect(existsSync(join(runs, 'dashboard', `${seeded}.log`))).toBe(true);

      // Only one run starts in this process, so the seeded run stands in for a suspended one.
      writeFileSync(join(runs, seeded, 'STATUS'), 'suspended until\n');
      const stopped = await fetch(`${base}/${seeded}/stop`, { method: 'POST', headers: POST, body: '{"now":false}' });
      expect([stopped.status, await stopped.json()]).toEqual([202, { message: `run ${seeded} stopped` }]);
      expect(statusOf(join(runs, seeded))).toBe('failed stopped');

      const { branch } = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { branch: string };
      const refused = await fetch(`${base}/${runId}/clean`, { method: 'POST', headers: POST, body: '{}' });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toContain('has an open pull request');
      const prs = join(runs, 'fake', 'prs.json');
      const hosted = JSON.parse(readFileSync(prs, 'utf8')) as { pullRequests: { head: string; state: string }[] };
      for (const pull of hosted.pullRequests) if (pull.head === branch) pull.state = 'closed';
      writeFileSync(prs, JSON.stringify(hosted));
      const cleaned = await fetch(`${base}/${runId}/clean`, { method: 'POST', headers: POST, body: '{}' });
      const answer = (await cleaned.json()) as { message: string; archived: string };
      expect(cleaned.status).toBe(200);
      expect(answer.archived).toStartWith(join(repo.home, '.sail', 'failed-runs'));
      expect(existsSync(join(answer.archived, 'run.json'))).toBe(true);
      expect(existsSync(dir)).toBe(false);
      expect(repo.git('branch', '--list', branch).trim()).toBe('');
      const listed = (await (await fetch(base, { headers: { 'X-Sail-Dashboard': '1' } })).json()) as {
        runId: string;
      }[];
      expect(listed.map((run) => run.runId)).not.toContain(runId);
    } finally {
      await started.stop();
    }
  });
}, 180_000);

test('a restart of this stage only leaves the new run suspended on until', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const env = { ...repo.env, SAIL_HOME: join(repo.home, '.sail') };
    const ran = await runCaptured(['FAKE-1', '--until', 'spec'], repo.dir, { env });
    expect(ran.code).toBe(EXIT_SUSPENDED);
    const runs = join(repo.dir, '.sail-runs');
    const [runId = ''] = readdirSync(runs).filter((name) => isRunIdOf('FAKE-1', name));
    const dir = join(runs, runId);
    const registry = registryDir(machineDir(env));
    const { name = '' } = readRegistry(registry).entries.find((entry) => entry.clone === repo.dir) ?? {};
    const started = startDashboard({ registryDir: registry, port: 0, env });
    if ('refused' in started) throw new Error(started.refused);
    try {
      const base = `http://127.0.0.1:${started.port}/api/repos/${name}/runs`;
      await fetch(`${base}/${runId}/resume`, { method: 'POST', headers: POST, body: '{}' });
      await until('the resumed run to end', () => statusOf(dir) === 'completed' && endedCompleted(dir));

      const restarted = await fetch(`${base}/${runId}/restart`, {
        method: 'POST',
        headers: POST,
        body: '{"stage":"spec","continue":false}',
      });
      const { runId: seeded } = (await restarted.json()) as { runId: string };
      expect(restarted.status).toBe(202);
      await until('the seeded run to be suspended', () => statusOf(join(runs, seeded)).startsWith('suspended'));
      expect(statusOf(join(runs, seeded))).toBe('suspended until');
    } finally {
      await started.stop();
    }
  });
}, 180_000);

test('a live run held in a call is suspended and held from the dashboard, ends suspended interrupted, then offers Resume', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    setHoldAt(repo.dir, 'implement#1');
    const env = { ...repo.env, SAIL_HOME: join(repo.home, 'sail-home') };
    const runs = join(repo.dir, '.sail-runs');
    const running = sailProcess(repo.dir, env, ['FAKE-1']);
    const registry = registryDir(machineDir(env));
    const started = startDashboard({ registryDir: registry, port: 0, env });
    if ('refused' in started) throw new Error(started.refused);
    try {
      await until('the run holding at implement#1', () => heldRuns(repo.dir).length === 1);
      const runId = heldRuns(repo.dir)[0]?.runId ?? '';
      const { name = '' } = readRegistry(registry).entries.find((entry) => entry.clone === repo.dir) ?? {};
      const base = `http://127.0.0.1:${started.port}/api/repos/${name}/runs/${runId}`;
      const offers = async () =>
        (await (await fetch(`${base}/actions`, { headers: { 'X-Sail-Dashboard': '1' } })).json()) as Record<
          string,
          { enabled: boolean }
        >;
      expect((await offers()).suspend).toEqual({ enabled: true });
      const answer = await fetch(`${base}/stop`, {
        method: 'POST',
        headers: POST,
        body: '{"now":false,"suspend":true}',
      });
      expect([answer.status, await answer.json()]).toEqual([
        202,
        { message: `run ${runId} suspends now, held until sail resume ${runId} (pid ${running.pid})` },
      ]);
      await until('the run to suspend', () => statusOf(join(runs, runId)) === 'suspended interrupted');
      await running.exited;
      expect(existsSync(join(runs, runId, 'HOLD'))).toBe(true);
      const after = await offers();
      expect(after.resume?.enabled).toBe(true);
      expect(after).not.toHaveProperty('suspend');
    } finally {
      await started.stop();
    }
  });
}, 180_000);
