// `sail stop <run>` (DECISIONS D7): refusals and a suspended run through run() in process, with no watcher; and a
// running manual run in a process of its own, held at the stub's gate, stopped by `sail stop` from a second process.
// The real-process case signals no process: the run ends on its own once the gate opens.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { readStatus } from '../../src/engine/run-dir';
import { runWorkflow } from '../../src/engine/runtime';
import { validateRunDir } from '../../src/engine/schemas';
import { fakeAdapters } from '../helpers/adapters';
import { edit } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { killOne, runsIn, sail, sailProcess, until, WAIT_MS } from '../helpers/sail-process';
import { heldRuns, releaseHeld, setHoldAt, writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const COMPLETED = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const FAILED = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3P';
const UNKNOWN = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3Q';

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('sail stop with no run says its usage, and a run that is unknown, completed or failed exits 3 naming why, writing nothing', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const runs = join(repo.dir, '.sail-runs');
    for (const [runId, status] of [
      [COMPLETED, 'completed\n'],
      [FAILED, 'failed stage_error\n'],
    ] as const) {
      mkdirSync(join(runs, runId), { recursive: true });
      writeFileSync(join(runs, runId, 'run.json'), '{}\n');
      writeFileSync(join(runs, runId, 'STATUS'), status);
    }
    const listing = () => readdirSync(runs).map((name) => `${name}: ${readdirSync(join(runs, name)).join(' ')}`);
    const before = listing();
    const results = [];
    for (const argv of [['stop'], ['stop', UNKNOWN], ['stop', COMPLETED], ['stop', FAILED]]) {
      results.push(await runCaptured(argv, repo.dir, { env: repo.env }));
    }
    expect(results).toEqual([
      { code: EXIT_REFUSED, stdout: '', stderr: 'sail stop: usage: sail stop <run>\n' },
      { code: EXIT_REFUSED, stdout: '', stderr: `sail stop: no run '${UNKNOWN}' in .sail-runs\n` },
      {
        code: EXIT_REFUSED,
        stdout: '',
        stderr: `sail stop: run ${COMPLETED} has ended (completed): there is nothing to stop\n`,
      },
      {
        code: EXIT_REFUSED,
        stdout: '',
        stderr: `sail stop: run ${FAILED} has ended (failed stage_error): there is nothing to stop\n`,
      },
    ]);
    expect(listing()).toEqual(before);
  });
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('sail stop ends a suspended run with no watcher running, and asks for no ticket source credentials', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeStub(repo.dir);
    const end = await runWorkflow({
      cwd: repo.dir,
      adapters: await fakeAdapters(repo.dir),
      workflow: 'ticket-to-pr',
      ticket: 'FAKE-1',
      until: 'spec',
    });
    if ('refused' in end) throw new Error(end.refused);
    edit(sailDir, 'project.yaml', 'ticketSource: { use: fake }', 'ticketSource: { use: linear, team: ADW }');
    const { LINEAR_API_KEY: _, ...env } = repo.env;
    const stopped = await runCaptured(['stop', end.runId], repo.dir, { env });
    expect({ ...stopped, status: readStatus(end.dir) }).toEqual({
      code: EXIT_OK,
      stdout: `sail stop: run ${end.runId} stopped\n`,
      stderr: '',
      status: { status: 'failed', stopReason: 'stopped' },
    });
  });
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a manual run held in a call is asked to stop by sail stop from another process, which exits 0 at once, and the run ends failed stopped at its next call boundary, its lease released', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    setHoldAt(repo.dir, 'implement#1');
    const env = { ...repo.env, SAIL_HOME: join(repo.home, 'sail-home') };
    const runs = join(repo.dir, '.sail-runs');
    const running = sailProcess(repo.dir, env, ['FAKE-1']);
    try {
      expect(await until('the run holding at implement#1', () => heldRuns(repo.dir).length === 1)).toBe(
        'the run holding at implement#1',
      );
      const [held] = heldRuns(repo.dir);
      const runId = held?.runId ?? '';
      const stopped = await sail(repo.dir, env, ['stop', runId]);
      const control = join(runs, runId, 'CONTROL');
      expect({ ...stopped, control: existsSync(control) ? readFileSync(control, 'utf8') : 'none' }).toEqual({
        code: EXIT_OK,
        stdout: `sail stop: run ${runId} stops at its next call boundary (pid ${running.pid})\n`,
        stderr: '',
        control: 'stopped\n',
      });
      releaseHeld(repo.dir);
      const code = await Promise.race([running.exited, Bun.sleep(WAIT_MS).then(() => 'still running')]);
      const [run] = runsIn(runs);
      const leases = join(runs, 'fake', 'leases');
      expect({
        code,
        status: run?.status,
        end: run?.events.at(-1),
        leases: existsSync(leases) ? readdirSync(leases).filter((name) => name.endsWith('.json')) : [],
        control: existsSync(join(runs, runId, 'CONTROL')),
        issues: validateRunDir(join(runs, runId)).issues,
      }).toEqual({
        code: EXIT_FAILED,
        status: 'failed stopped',
        end: expect.objectContaining({
          type: 'run:end',
          status: 'failed',
          stopReason: 'stopped',
          message: 'stopped by sail stop before tests#1',
        }),
        leases: [],
        control: false,
        issues: [],
      });
    } finally {
      releaseHeld(repo.dir);
      if (running.exitCode === null) killOne(running.pid, 'SIGKILL');
    }
  });
}, 150_000);
