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
import { openQueue } from '../../src/watch/queue-store';
import { fakeAdapters } from '../helpers/adapters';
import { edit } from '../helpers/fixture';
import { manualClock, ticket } from '../helpers/queue';
import { runCaptured } from '../helpers/run-captured';
import { killOne, runsIn, sail, sailProcess, until, WAIT_MS } from '../helpers/sail-process';
import { heldRuns, releaseHeld, setHoldAt, writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const COMPLETED = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const FAILED = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3P';
const UNKNOWN = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3Q';

test('sail stop with no run says its usage, and a run that is unknown, completed or failed exits 3 naming why, writing nothing', async () => {
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
      { code: EXIT_REFUSED, stdout: '', stderr: 'sail stop: usage: sail stop <run> [--now]\n' },
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

test('sail stop ends a suspended run with no watcher running, and asks for no ticket source credentials', async () => {
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

test.each([false, true])(
  'a manual run held in a call obeys sail stop now=%s from another process',
  async (now) => {
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
        const stopped = await sail(repo.dir, env, ['stop', runId, ...(now ? ['--now'] : [])]);
        const control = join(runs, runId, 'CONTROL');
        expect({ ...stopped, control: existsSync(control) ? readFileSync(control, 'utf8') : 'none' }).toEqual({
          code: EXIT_OK,
          stdout: now
            ? `sail stop: run ${runId} ends its running call now (pid ${running.pid})\n`
            : `sail stop: run ${runId} stops at its next call boundary (pid ${running.pid})\n`,
          stderr: '',
          control: now ? 'stopped now\n' : 'stopped\n',
        });
        if (!now) releaseHeld(repo.dir);
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
            message: now ? 'stopped by sail stop --now during implement#1' : 'stopped by sail stop before tests#1',
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
  },
  150_000,
);

const STARTING = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';

/** A queue holding FAKE-1 dispatched under `STARTING`, with the process `pid` when one is given. */
function dispatchFake1(runs: string, pid?: number): void {
  const store = openQueue({
    runsDir: runs,
    workflow: 'ticket-to-pr',
    label: 'sail',
    now: manualClock('2026-10-14T09:00:00.000Z'),
  });
  if ('refused' in store) throw new Error(store.refused);
  store.add([ticket('FAKE-1')]);
  store.dispatched('ticket:FAKE-1', STARTING);
  if (pid !== undefined) store.spawned('ticket:FAKE-1', pid);
}

test('sail stop on a dispatched run with no directory yet exits 0 saying it is still starting and writes a stopped hand-off, and the run started under that id then fails stopped before intake#1', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    repo.git('add', '.sail');
    repo.git('commit', '-q', '-m', 'definitions');
    const runs = join(repo.dir, '.sail-runs');
    dispatchFake1(runs);
    const handOff = join(runs, `${STARTING}.control`);
    const stopped = await runCaptured(['stop', STARTING], repo.dir, { env: repo.env });
    expect({ ...stopped, handOff: readFileSync(handOff, 'utf8') }).toEqual({
      code: EXIT_OK,
      stdout: `sail stop: run ${STARTING} is still starting: it stops before its intake\n`,
      stderr: '',
      handOff: 'stopped\n',
    });
    const started = await runCaptured(['FAKE-1', '--workflow', 'ticket-to-pr', '--dispatch', STARTING], repo.dir, {
      env: repo.env,
    });
    const events = readFileSync(join(runs, STARTING, 'events.ndjson'), 'utf8');
    expect({
      code: started.code,
      status: readStatus(join(runs, STARTING)),
      stoppedBeforeIntake: events.includes('stopped by sail stop before intake#1'),
      calls: events.includes('"type":"call:start"'),
      handOff: existsSync(handOff),
    }).toEqual({
      code: EXIT_FAILED,
      status: { status: 'failed', stopReason: 'stopped' },
      stoppedBeforeIntake: true,
      calls: false,
      handOff: false,
    });
  });
}, 60_000);

test('sail stop on a run a dispatched item names with a dead process, or that no item names, exits 3 with no run and writes nothing', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const runs = join(repo.dir, '.sail-runs');
    dispatchFake1(runs, 2_000_000_000);
    const dead = await runCaptured(['stop', STARTING], repo.dir, { env: repo.env });
    const unknown = await runCaptured(['stop', UNKNOWN], repo.dir, { env: repo.env });
    expect({
      dead,
      unknown,
      files: readdirSync(runs).filter((name) => name.endsWith('.control')),
    }).toEqual({
      dead: { code: EXIT_REFUSED, stdout: '', stderr: `sail stop: no run '${STARTING}' in .sail-runs\n` },
      unknown: { code: EXIT_REFUSED, stdout: '', stderr: `sail stop: no run '${UNKNOWN}' in .sail-runs\n` },
      files: [],
    });
  });
});
