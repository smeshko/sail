// `sail clean <run>... | --failed`: the selection, the exit codes of a refusal and of a failed removal, and a clean
// that never resolves the code host when the branch is not on the remote.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanCommand } from '../../src/cli/commands/clean';
import { type WatchDeps, watchCommand } from '../../src/cli/commands/watch';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import type { Io } from '../../src/cli/index';
import { writeStatus } from '../../src/engine/run-dir';
import { readRunHeader } from '../../src/engine/run-header';
import { runWorkflow } from '../../src/engine/runtime';
import { commandsDir } from '../../src/watch/inbox';
import { queueDir } from '../../src/watch/queue-store';
import { readEntry } from '../../src/watch/registry';
import { fakeAdapters } from '../helpers/adapters';
import { fakeTimers } from '../helpers/fake-timers';
import { edit } from '../helpers/fixture';
import { withOrigin } from '../helpers/origin';
import { fakeInterrupts, runCaptured } from '../helpers/run-captured';
import { sail as sailProcess } from '../helpers/sail-process';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';
import { fakeSpawner, writeTickets, writeWatched } from '../helpers/watched';

const USAGE = 'sail clean: usage: sail clean <run>... | --failed [--requeue|--drop]\n';

const env = (repo: TempRepo) => ({ ...repo.env, SAIL_HOME: join(dirname(repo.dir), 'sail-home') });
const sail = (repo: TempRepo, ...argv: string[]) => runCaptured(argv, repo.dir, { env: env(repo) });

/** A run of `ticket` suspended after `spec`, ended as `status` says. */
async function run(repo: TempRepo, ticket: string, status?: 'failed' | 'completed'): Promise<string> {
  const end = await runWorkflow({
    cwd: repo.dir,
    adapters: await fakeAdapters(repo.dir),
    workflow: 'ticket-to-pr',
    ticket,
    until: 'spec',
  });
  if ('refused' in end) throw new Error(end.refused);
  if (status === 'failed') writeStatus(end.dir, 'failed', 'workflow_failed');
  if (status === 'completed') writeStatus(end.dir, 'completed');
  return end.runId;
}

function project(repo: TempRepo): void {
  writeStub(repo.dir);
  mkdirSync(join(repo.dir, '.sail', 'fake'), { recursive: true });
  writeFileSync(
    join(repo.dir, '.sail', 'fake', 'prs.json'),
    JSON.stringify({ remote: 'fake://codehost/stub', defaultBranch: 'main', branches: {}, pullRequests: [] }),
  );
}

/** A run directory with only a header and a STATUS: enough to be listed, and to be refused or skipped. */
function bareRun(repo: TempRepo, runId: string, status: string): string {
  const dir = join(repo.dir, '.sail-runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), '{}\n');
  writeFileSync(join(dir, 'STATUS'), `${status}\n`);
  return runId;
}

/** Cleans with the git-worktree workspace, over a bare origin, from here on. */
function useGit(repo: TempRepo, codeHost = 'fake'): void {
  withOrigin(repo);
  edit(join(repo.dir, '.sail'), 'project.yaml', 'workspace: { use: fake }', 'workspace: { use: git-worktree }');
  edit(join(repo.dir, '.sail'), 'project.yaml', 'codeHost: { use: fake }', `codeHost: { use: ${codeHost} }`);
}

const branchOf = (repo: TempRepo, runId: string): string => {
  const branch = readRunHeader(join(repo.dir, '.sail-runs', runId)).branch;
  if (branch === undefined) throw new Error('no branch');
  return branch;
};

const exists = (repo: TempRepo, runId: string) => existsSync(join(repo.dir, '.sail-runs', runId));

test('sail clean with no run, or a run and --failed, says its usage and exits 3', async () => {
  await withTempRepo(async (repo) => {
    project(repo);
    expect(await sail(repo, 'clean')).toEqual({ code: EXIT_REFUSED, stdout: '', stderr: USAGE });
    expect(await sail(repo, 'clean', '--failed', 'FAKE-1-X')).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: USAGE,
    });
  });
});

test('sail clean <failed> <completed> cleans the first, refuses the second and exits 3', async () => {
  await withTempRepo(async (repo) => {
    project(repo);
    const failed = await run(repo, 'FAKE-1', 'failed');
    const completed = bareRun(repo, 'FAKE-2-01M6AYGAR4GKMHE5Y5BWJEW90T', 'completed');
    const result = await sail(repo, 'clean', failed, completed);
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.stdout).toMatch(new RegExp(`^cleaned ${failed}: worktree; run directory -> `));
    expect(result.stdout.split('\n').filter(Boolean)).toEqual([
      expect.stringMatching(new RegExp(`^cleaned ${failed}: `)),
      'reset FAKE-1 to Todo',
    ]);
    expect(result.stderr).toBe(`sail clean: run ${completed} completed: only a failed run is cleaned\n`);
    expect(exists(repo, failed)).toBe(false);
    expect(exists(repo, completed)).toBe(true);
  });
});

test('sail clean --failed cleans only the failed runs, and says so when there are none', async () => {
  await withTempRepo(async (repo) => {
    project(repo);
    const failed = await run(repo, 'FAKE-1', 'failed');
    const completed = bareRun(repo, 'FAKE-2-01M6AYGAR4GKMHE5Y5BWJEW90T', 'completed');
    const suspended = bareRun(repo, 'FAKE-3-01M6AYGAR4GKMHE5Y5BWJEW90T', 'suspended');
    const result = await sail(repo, 'clean', '--failed');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain(`cleaned ${failed}:`);
    expect(result.stderr).toBe('');
    const runs = await sail(repo, 'runs');
    expect(runs.stdout).toContain(completed);
    expect(runs.stdout).toContain(suspended);
    expect(runs.stdout).not.toContain(failed);
    expect(await sail(repo, 'clean', '--failed')).toEqual({
      code: EXIT_OK,
      stdout: '',
      stderr: 'sail clean: no failed runs\n',
    });
  });
});

const ticketState = async (repo: TempRepo, key = 'FAKE-1') =>
  (await (await fakeAdapters(repo.dir)).ports.ticketSource.get(key)).state;

test('sail clean --failed moves the started ticket of a cleaned run back to unstarted and says so', async () => {
  await withTempRepo(async (repo) => {
    project(repo);
    const failed = await run(repo, 'FAKE-1', 'failed');
    expect((await ticketState(repo)).type).toBe('started');
    const result = await sail(repo, 'clean', '--failed');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('\nreset FAKE-1 to Todo\n');
    expect(result.stderr).toBe('');
    expect(await ticketState(repo)).toEqual({ type: 'unstarted', name: 'Todo' });
    expect(exists(repo, failed)).toBe(false);
  });
});

test('sail clean prints no reset for a ticket that is no longer started, and leaves it', async () => {
  await withTempRepo(async (repo) => {
    project(repo);
    const failed = await run(repo, 'FAKE-1', 'failed');
    await (await fakeAdapters(repo.dir)).ports.ticketSource.update('FAKE-1', { state: 'done' });
    const result = await sail(repo, 'clean', failed);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).not.toContain('reset');
    expect((await ticketState(repo)).type).toBe('completed');
  });
});

test('sail clean exits 1 when the ticket cannot be reset, naming the ticket, and the clean stays archived', async () => {
  await withTempRepo(async (repo) => {
    project(repo);
    const failed = await run(repo, 'FAKE-1', 'failed');
    const path = join(repo.dir, '.sail-runs', 'fake', 'tickets.json');
    const seed = JSON.parse(readFileSync(path, 'utf8'));
    seed.tickets[0].answers = { update: ['unavailable'] };
    writeFileSync(path, JSON.stringify(seed));
    const result = await sail(repo, 'clean', failed);
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.stderr).toContain(`sail clean: ${failed}: its ticket FAKE-1 was not reset: `);
    expect(exists(repo, failed)).toBe(false);
    expect((await ticketState(repo)).type).toBe('started');
  });
});

test('sail clean exits 1 when a removal fails, keeping the run directory, and a second clean finishes it; it needs no code host with no remote branch', async () => {
  await withTempRepo(async (repo) => {
    project(repo);
    const failed = await run(repo, 'FAKE-1', 'failed');
    useGit(repo, 'github');
    const branch = branchOf(repo, failed);
    repo.git('update-ref', `refs/heads/${branch}`, 'HEAD');
    repo.git('checkout', '--quiet', branch);
    const first = await runCaptured(['clean', failed], repo.dir, { env: { ...env(repo), GITHUB_TOKEN: '' } });
    expect(first.code).toBe(EXIT_FAILED);
    expect(first.stderr).toContain(`sail clean: ${failed}: the branch ${branch} was not removed: `);
    expect(first.stderr).toContain(
      `sail clean: ${failed}: its run directory stays at .sail-runs/${failed}; clean it again\n`,
    );
    expect(exists(repo, failed)).toBe(true);
    repo.git('checkout', '--quiet', 'main');
    const second = await runCaptured(['clean', failed], repo.dir, { env: { ...env(repo), GITHUB_TOKEN: '' } });
    expect(second.code).toBe(EXIT_OK);
    expect(exists(repo, failed)).toBe(false);
  });
});

test('sail clean refuses a run whose branch is on the remote when the code host cannot be resolved', async () => {
  await withTempRepo(async (repo) => {
    project(repo);
    const failed = await run(repo, 'FAKE-1', 'failed');
    useGit(repo, 'github');
    repo.git('push', '--quiet', 'origin', `HEAD:refs/heads/${branchOf(repo, failed)}`);
    const result = await runCaptured(['clean', failed], repo.dir, { env: { ...env(repo), GITHUB_TOKEN: '' } });
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.stderr).toStartWith(`sail clean: run ${failed}: the open pull requests of `);
    expect(exists(repo, failed)).toBe(true);
  });
});

/** A failed run of `ticket` made by a `sail` process of its own, since one process opens one run of a repository. */
async function failedByProcess(repo: TempRepo, ticket: string): Promise<string> {
  const before = new Set(readdirSync(join(repo.dir, '.sail-runs')));
  await sailProcess(repo.dir, env(repo), [ticket, '--until', 'spec']);
  const made = readdirSync(join(repo.dir, '.sail-runs')).find(
    (name) => name.startsWith(`${ticket}-`) && !before.has(name),
  );
  if (made === undefined) throw new Error(`no run of ${ticket} was made`);
  writeStatus(join(repo.dir, '.sail-runs', made), 'failed', 'workflow_failed');
  return made;
}

const START = '2026-10-15T09:00:00.000Z';
const WATCHER_PID = 4242;

/**
 * The stub with a watched workflow `a` (label sail-a, cap 1) whose queue holds a parked item of FAKE-1 naming FAKE-1's
 * failed run, and a second failed run of FAKE-2 that no item names. With `watching`, a watcher of `a` runs in process
 * on fake timers and has dispatched FAKE-3, which fills the cap so a requeued item stays queued.
 */
async function queued(repo: TempRepo, watching = true) {
  project(repo);
  const sail = join(repo.dir, '.sail');
  writeWatched(sail, 'a', { label: 'sail-a', cap: 1 });
  writeTickets(sail, [
    { key: 'FAKE-1', labels: ['sail', 'sail-a'] },
    { key: 'FAKE-2', labels: ['sail'] },
    { key: 'FAKE-3', labels: ['sail-a'] },
  ]);
  const named = await run(repo, 'FAKE-1', 'failed');
  const unnamed = await failedByProcess(repo, 'FAKE-2');
  const runs = join(repo.dir, '.sail-runs');
  const dir = queueDir(runs, 'a');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'queue.json'),
    JSON.stringify({
      version: 1,
      workflow: 'a',
      updatedAt: START,
      polling: { label: 'sail-a', failures: 0 },
      items: [
        {
          dedupKey: 'ticket:FAKE-1',
          source: { kind: 'ticket', ticketKey: 'FAKE-1' },
          title: 'Ticket FAKE-1',
          url: 'fake://tickets/FAKE-1',
          state: 'parked',
          attempts: 2,
          addedAt: START,
          runId: named,
          reason: 'spec blocked',
        },
      ],
    }),
  );
  const sailEnv = { ...repo.env, SAIL_HOME: join(repo.home, 'sail-home') };
  const timers = fakeTimers(START);
  const spawner = fakeSpawner(runs);
  const isAlive = (pid: number) => pid === WATCHER_PID || spawner.isAlive(pid);
  const deps: WatchDeps = {
    timers,
    now: timers.now,
    spawn: spawner.spawn,
    resume: spawner.resume,
    isAlive,
    pid: WATCHER_PID,
  };
  const interrupts = fakeInterrupts();
  const handle = (printed: { stdout: string; stderr: string }, onInterrupt?: Io['onInterrupt']): Io => ({
    cwd: repo.dir,
    env: sailEnv,
    stdout: (text) => {
      printed.stdout += text;
    },
    stderr: (text) => {
      printed.stderr += text;
    },
    ...(onInterrupt === undefined ? {} : { onInterrupt }),
  });
  let exited: Promise<unknown> = Promise.resolve();
  if (watching) {
    exited = Promise.resolve(
      watchCommand(deps)(
        { values: {}, positionals: ['a'] },
        handle({ stdout: '', stderr: '' }, interrupts.onInterrupt),
      ),
    );
    const deadline = performance.now() + 10_000;
    while (readEntry(join(repo.home, 'sail-home', 'watchers'), 'stub')?.watcher === undefined) {
      if (performance.now() > deadline) throw new Error('the watcher did not start');
      await Bun.sleep(5);
    }
    await timers.advance(1000);
  }
  /** Runs `sail clean <argv>` beside the watcher, ticking it once the command has dropped its file. */
  const cleaned = async (...argv: string[]) => {
    const printed = { stdout: '', stderr: '' };
    const values: Record<string, boolean> = {};
    const positionals: string[] = [];
    for (const arg of argv) {
      if (arg.startsWith('--')) values[arg.slice(2)] = true;
      else positionals.push(arg);
    }
    let ended = false;
    const done = Promise.resolve(
      cleanCommand({ isAlive, pollMs: 5, applyTimeoutMs: 5000 })({ values, positionals }, handle(printed)),
    ).finally(() => {
      ended = true;
    });
    const deadline = performance.now() + 20_000;
    const dropped = () =>
      existsSync(commandsDir(runs)) && readdirSync(commandsDir(runs)).some((name) => name.endsWith('.json'));
    while (!dropped() && !ended) {
      if (performance.now() > deadline) throw new Error('no command was dropped');
      await Bun.sleep(5);
    }
    if (!ended) await timers.advance(1000);
    return { code: await done, ...printed };
  };
  const items = (): Record<string, unknown>[] =>
    JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')).items as Record<string, unknown>[];
  const stop = async () => {
    interrupts.interrupt();
    await exited;
  };
  return { named, unnamed, cleaned, items, stop };
}

const labels = async (repo: TempRepo) => (await (await fakeAdapters(repo.dir)).ports.ticketSource.get('FAKE-1')).labels;

test('sail clean --failed without --requeue or --drop refuses the run a queue item names, naming both flags, and still cleans the others', async () => {
  await withTempRepo(async (repo) => {
    const w = await queued(repo);
    const result = await w.cleaned('--failed');
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.stderr).toBe(
      `sail clean: queue item ticket:FAKE-1 of a (parked) names run ${w.named}: clean it with --requeue or --drop, or \`sail queue requeue|drop\`\n`,
    );
    expect(result.stdout).toContain(`cleaned ${w.unnamed}:`);
    expect(exists(repo, w.named)).toBe(true);
    expect(exists(repo, w.unnamed)).toBe(false);
    expect(w.items().find((item) => item.dedupKey === 'ticket:FAKE-1')).toMatchObject({
      state: 'parked',
      runId: w.named,
    });
    await w.stop();
  });
}, 60_000);

test('sail clean --requeue cleans the named run, resets its ticket and queues its item again through the watcher', async () => {
  await withTempRepo(async (repo) => {
    const w = await queued(repo);
    const result = await w.cleaned(w.named, '--requeue');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.split('\n').filter(Boolean)).toEqual([
      expect.stringMatching(new RegExp(`^cleaned ${w.named}: `)),
      'reset FAKE-1 to Todo',
      'requeued queued ticket:FAKE-1 Ticket FAKE-1',
    ]);
    expect(exists(repo, w.named)).toBe(false);
    const [item] = w.items();
    expect(item).toMatchObject({ dedupKey: 'ticket:FAKE-1', state: 'queued' });
    expect(item).not.toHaveProperty('runId');
    expect((await ticketState(repo)).type).toBe('unstarted');
    expect(await labels(repo)).toContain('sail-a');
    await w.stop();
  });
}, 60_000);

test('sail clean --drop cleans the named run, drops its item through the watcher and takes the watcher label off the ticket', async () => {
  await withTempRepo(async (repo) => {
    const w = await queued(repo);
    const result = await w.cleaned(w.named, '--drop');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.split('\n').filter(Boolean)).toEqual([
      expect.stringMatching(new RegExp(`^cleaned ${w.named}: `)),
      'reset FAKE-1 to Todo',
      'ticket:FAKE-1 dropped',
    ]);
    expect(w.items().map((item) => item.dedupKey)).toEqual(['ticket:FAKE-3']);
    expect(exists(repo, w.named)).toBe(false);
    expect(await labels(repo)).toEqual(['sail']);
    await w.stop();
  });
}, 60_000);

test('sail clean --requeue with no live watcher refuses the named run with nothing removed, and cleans the unnamed one', async () => {
  await withTempRepo(async (repo) => {
    const w = await queued(repo, false);
    const result = await w.cleaned('--failed', '--requeue');
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.stderr).toContain(`run ${w.named}: no watcher is running for 'stub' here: sail watch a first`);
    expect(result.stdout).toContain(`cleaned ${w.unnamed}:`);
    expect(exists(repo, w.named)).toBe(true);
    expect(existsSync(join(repo.dir, '.sail-runs', w.named, 'workspace'))).toBe(true);
    expect((await ticketState(repo)).type).toBe('started');
    expect(w.items().map((item) => item.state)).toEqual(['parked']);
  });
}, 60_000);

test('sail clean --requeue with --drop is refused with the usage line', async () => {
  await withTempRepo(async (repo) => {
    project(repo);
    expect(await sail(repo, 'clean', '--failed', '--requeue', '--drop')).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: USAGE,
    });
  });
});
