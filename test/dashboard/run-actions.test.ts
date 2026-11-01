// A person's Resume and Restart, end to end: the dashboard server starts the real `sail` detached in a repository of the
// fixture workflow, and the run it starts goes on after the dashboard stops. `sail FAKE-1 --until spec` suspends a run;
// a POST to resume it finishes it. Then its STATUS is made `failed`, and a POST to restart it from spec starts a seeded
// run under a new id, whose run.json names the run it was seeded from. The seeded run, made suspended, is stopped from the
// dashboard, and the failed one is cleaned: its branch and run directory go, and the archive holds the directory.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { startDashboard } from '../../src/dashboard/server';
import { isRunIdOf } from '../../src/engine/run-id';
import { machineDir, readRegistry, registryDir } from '../../src/watch/registry';
import { copyFixture } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { withTempRepo } from '../helpers/temp-repo';

const POST = { 'X-Sail-Dashboard': '1', 'Content-Type': 'application/json' };

const statusOf = (dir: string) => readFileSync(join(dir, 'STATUS'), 'utf8').trim();

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
      await until('the resumed run to complete', () => statusOf(dir) === 'completed');

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
      await until('the seeded run to complete', () => statusOf(join(runs, seeded)) === 'completed');
      expect(existsSync(join(runs, 'dashboard', `${seeded}.log`))).toBe(true);

      // Only one run starts in this process, so the seeded run stands in for a suspended one.
      writeFileSync(join(runs, seeded, 'STATUS'), 'suspended until\n');
      const deadline = Date.now() + 20_000;
      // The process that ran it can still hold its lease for a moment after it wrote `completed`.
      let stopped: { status: number; body: unknown };
      do {
        const response = await fetch(`${base}/${seeded}/stop`, {
          method: 'POST',
          headers: POST,
          body: '{"now":false}',
        });
        stopped = { status: response.status, body: await response.json() };
        if (JSON.stringify(stopped.body).includes('stopped"')) break;
        await Bun.sleep(200);
      } while (Date.now() < deadline);
      expect([stopped.status, stopped.body]).toEqual([202, { message: `run ${seeded} stopped` }]);
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
