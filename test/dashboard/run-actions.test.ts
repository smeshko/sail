// A person's Resume and Restart, end to end: the dashboard server starts the real `sail` detached in a repository of the
// fixture workflow, and the run it starts goes on after the dashboard stops. `sail FAKE-1 --until spec` suspends a run;
// a POST to resume it finishes it. Then its STATUS is made `failed`, and a POST to restart it from spec starts a seeded
// run under a new id, whose run.json names the run it was seeded from.
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

test('a suspended run resumes to completion from the dashboard, and a failed one restarts as a seeded run from a stage it ran', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const ran = await runCaptured(['FAKE-1', '--until', 'spec'], repo.dir, { env: repo.env });
    expect(ran.code).toBe(EXIT_SUSPENDED);
    const runs = join(repo.dir, '.sail-runs');
    const [runId = ''] = readdirSync(runs).filter((name) => isRunIdOf('FAKE-1', name));
    const dir = join(runs, runId);
    expect(statusOf(dir)).toStartWith('suspended');

    const registry = registryDir(machineDir(repo.env));
    const [{ name = '' } = {}] = readRegistry(registry).entries;
    const started = startDashboard({ registryDir: registry, port: 0, env: repo.env });
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
    } finally {
      await started.stop();
    }
  });
}, 180_000);
