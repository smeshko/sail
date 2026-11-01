// cleanRun(): the checks that refuse a run still in use, the removals in order, and the archive of the run directory.
// On the stub workflow and the fake adapters; a git-worktree workspace over a bare origin covers the remote branch.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createGitWorktreeWorkspace } from '../../src/adapters/workspace/git-worktree';
import { type Cleaned, cleanRun } from '../../src/engine/clean';
import { writeOpening, writeStatus } from '../../src/engine/run-dir';
import { readRunHeader } from '../../src/engine/run-header';
import { type RunEnd, runWorkflow } from '../../src/engine/runtime';
import { stopRun } from '../../src/engine/stop';
import type { CodeHost } from '../../src/ports/code-host';
import type { WorkspacePort } from '../../src/ports/workspace';
import { queueItemsNaming } from '../../src/watch/queue-store';
import { fakeAdapters } from '../helpers/adapters';
import { withOrigin } from '../helpers/origin';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const NOW = () => new Date(2026, 10, 1, 12, 0, 0);
const DAY = '2026-11-01';

/** The stub's run of FAKE-1 in `repo`, suspended with `until` after `spec#1`. */
async function suspendedRun(repo: TempRepo, ticket = 'FAKE-1'): Promise<RunEnd> {
  writeStub(repo.dir);
  mkdirSync(join(repo.dir, '.sail', 'fake'), { recursive: true });
  writeFileSync(
    join(repo.dir, '.sail', 'fake', 'prs.json'),
    JSON.stringify({ remote: 'fake://codehost/stub', defaultBranch: 'main', branches: {}, pullRequests: [] }),
  );
  const end = await runWorkflow({
    cwd: repo.dir,
    adapters: await fakeAdapters(repo.dir),
    workflow: 'ticket-to-pr',
    ticket,
    until: 'spec',
  });
  if ('refused' in end) throw new Error(end.refused);
  if (end.status !== 'suspended') throw new Error(`the run ended ${end.status}`);
  return end;
}

/** A run that failed with its worktree and lease as the run left them: STATUS alone says it ended. */
async function failedRun(repo: TempRepo): Promise<{ end: RunEnd; branch: string }> {
  const end = await suspendedRun(repo);
  writeStatus(end.dir, 'failed', 'workflow_failed');
  const branch = readRunHeader(end.dir).branch;
  if (branch === undefined) throw new Error('the run has no branch');
  return { end, branch };
}

const sailHome = (repo: TempRepo) => join(dirname(repo.dir), 'sail-home');
const sailDir = (repo: TempRepo) => join(repo.dir, '.sail');
const ref = (repo: TempRepo, name: string): boolean =>
  Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', name], { cwd: repo.dir, env: repo.env }).exitCode === 0;

/** `cleanRun()` over the fake adapters, the fake code host unless `codeHost` is given. */
async function clean(
  repo: TempRepo,
  runId: string,
  more: { workspace?: WorkspacePort; codeHost?: () => Promise<CodeHost | { refused: string }> } = {},
): Promise<Cleaned> {
  const adapters = await fakeAdapters(repo.dir);
  return cleanRun({
    sailDir: sailDir(repo),
    runId,
    workspace: more.workspace ?? adapters.ports.workspace,
    queueItems: (id) => queueItemsNaming(join(repo.dir, '.sail-runs'), id),
    codeHost: more.codeHost ?? (async () => adapters.ports.codeHost),
    env: { SAIL_HOME: sailHome(repo) },
    clock: NOW,
  });
}

const refusal = (cleaned: Cleaned): string => ('refused' in cleaned ? cleaned.refused : JSON.stringify(cleaned));

/** Writes a queue file for ticket-to-pr holding `item`. */
function queued(repo: TempRepo, item: Record<string, unknown>): void {
  const dir = join(repo.dir, '.sail-runs', 'queue', 'ticket-to-pr');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'queue.json'),
    JSON.stringify({
      version: 1,
      workflow: 'ticket-to-pr',
      updatedAt: '2026-10-31T00:00:00.000Z',
      polling: { label: 'sail', failures: 0 },
      items: [
        {
          dedupKey: 'ticket:FAKE-1',
          source: { kind: 'ticket', ticketKey: 'FAKE-1' },
          title: 'Add a shout flag',
          url: 'https://example.test/FAKE-1',
          state: 'queued',
          attempts: 1,
          addedAt: '2026-10-31T00:00:00.000Z',
          ...item,
        },
      ],
    }),
  );
}

test('an id that names no run is refused, naming the runs directory', async () => {
  await withTempRepo(async (repo) => {
    await suspendedRun(repo);
    expect(refusal(await clean(repo, 'NOPE-1'))).toBe("no run 'NOPE-1' in .sail-runs");
  });
});

test('an id that is no plain name is refused', async () => {
  await withTempRepo(async (repo) => {
    await suspendedRun(repo);
    expect(refusal(await clean(repo, '../x'))).toBe("'../x' is not a run id");
  });
});

test('a suspended run is refused, telling the user to stop it first, and stays where it is', async () => {
  await withTempRepo(async (repo) => {
    const end = await suspendedRun(repo);
    const refused = refusal(await clean(repo, end.runId));
    expect(refused).toContain(`stop it first: \`sail stop ${end.runId}\``);
    expect(existsSync(end.dir)).toBe(true);
  });
});

test('a run with no STATUS is refused, telling the user to stop it first', async () => {
  await withTempRepo(async (repo) => {
    const end = await suspendedRun(repo);
    Bun.spawnSync(['mv', join(end.dir, 'STATUS'), join(end.dir, 'STATUS.off')]);
    expect(refusal(await clean(repo, end.runId))).toContain(`stop it first: \`sail stop ${end.runId}\``);
  });
});

test('a completed run is refused: only a failed run is cleaned', async () => {
  await withTempRepo(async (repo) => {
    const end = await suspendedRun(repo);
    writeStatus(end.dir, 'completed');
    const refused = refusal(await clean(repo, end.runId));
    expect(refused).toContain(`run ${end.runId} completed`);
    expect(refused).toContain('only a failed run is cleaned');
  });
});

test('a branch another run leases refuses the clean, naming that run', async () => {
  await withTempRepo(async (repo) => {
    const { end, branch } = await failedRun(repo);
    const adapters = await fakeAdapters(repo.dir);
    const { url } = await adapters.ports.workspace.repository();
    const leased = await adapters.ports.workspace.lease(url, branch, {
      runId: 'OTHER-1',
      runDir: join(repo.dir, '.sail-runs', 'OTHER-1'),
      pid: process.pid,
    });
    expect(leased.leased).toBe(true);
    const refused = refusal(await clean(repo, end.runId));
    expect(refused).toContain('OTHER-1');
    expect(existsSync(end.dir)).toBe(true);
    expect(existsSync(join(end.dir, 'workspace'))).toBe(true);
  });
});

test('a live seeded run of it, which leases a branch of its own, refuses the clean, naming that run', async () => {
  await withTempRepo(async (repo) => {
    const { end, branch } = await failedRun(repo);
    const adapters = await fakeAdapters(repo.dir);
    const { url } = await adapters.ports.workspace.repository();
    const seededDir = join(repo.dir, '.sail-runs', 'SEED-1');
    mkdirSync(seededDir, { recursive: true });
    const seededBranch = `${branch}-seeded-abcd1234`;
    const header = readRunHeader(end.dir);
    writeFileSync(
      join(seededDir, 'run.json'),
      JSON.stringify({ ...header, runId: 'SEED-1', fromRun: end.runId, reused: 1, branch: seededBranch }),
    );
    writeStatus(seededDir, 'suspended', 'until');
    await adapters.ports.workspace.lease(url, seededBranch, { runId: 'SEED-1', runDir: seededDir, pid: process.pid });
    const refused = refusal(await clean(repo, end.runId));
    expect(refused).toContain('SEED-1');
    expect(existsSync(end.dir)).toBe(true);
  });
});

test('a seeded run of it still being opened, with only its OPENING, refuses the clean, naming that run', async () => {
  await withTempRepo(async (repo) => {
    const { end, branch } = await failedRun(repo);
    const adapters = await fakeAdapters(repo.dir);
    const { url } = await adapters.ports.workspace.repository();
    const seededDir = join(repo.dir, '.sail-runs', 'SEED-2');
    mkdirSync(seededDir, { recursive: true });
    const seededBranch = `${branch}-seeded-abcd1234`;
    writeOpening(seededDir, { workflow: 'ticket-to-pr', branch: seededBranch, remote: url });
    await adapters.ports.workspace.lease(url, seededBranch, { runId: 'SEED-2', runDir: seededDir, pid: process.pid });
    const refused = refusal(await clean(repo, end.runId));
    expect(refused).toContain('SEED-2');
    expect(existsSync(end.dir)).toBe(true);
  });
});

test('a seeded run of it that has ended does not refuse the clean', async () => {
  await withTempRepo(async (repo) => {
    const { end, branch } = await failedRun(repo);
    const seededDir = join(repo.dir, '.sail-runs', 'SEED-3');
    mkdirSync(seededDir, { recursive: true });
    const header = readRunHeader(end.dir);
    writeFileSync(
      join(seededDir, 'run.json'),
      JSON.stringify({
        ...header,
        runId: 'SEED-3',
        fromRun: end.runId,
        reused: 1,
        branch: `${branch}-seeded-abcd1234`,
      }),
    );
    writeStatus(seededDir, 'failed', 'workflow_failed');
    expect('cleaned' in (await clean(repo, end.runId))).toBe(true);
  });
});

for (const [state, extra] of [
  ['dispatched', {}],
  ['failed', { retryAt: '2026-11-02T00:00:00.000Z' }],
  ['parked', { reason: 'gave up' }],
] as const) {
  test(`a queue item in state ${state} that names the run refuses the clean, naming its dedup key and saying requeue or drop`, async () => {
    await withTempRepo(async (repo) => {
      const { end } = await failedRun(repo);
      queued(repo, { state, runId: end.runId, ...extra });
      const refused = refusal(await clean(repo, end.runId));
      expect(refused).toContain('ticket:FAKE-1');
      expect(refused).toContain('ticket-to-pr');
      expect(refused).toContain('requeue');
      expect(refused).toContain('drop');
      expect(existsSync(end.dir)).toBe(true);
    });
  });
}

test('a queue file that cannot be read refuses the clean, since an unanswered check is no permission', async () => {
  await withTempRepo(async (repo) => {
    const { end } = await failedRun(repo);
    const dir = join(repo.dir, '.sail-runs', 'queue', 'ticket-to-pr');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'queue.json'), '{ not json');
    const refused = refusal(await clean(repo, end.runId));
    expect(refused).toContain('queue.json');
    expect(existsSync(end.dir)).toBe(true);
  });
});

test('a queue item that names another run does not refuse the clean', async () => {
  await withTempRepo(async (repo) => {
    const { end } = await failedRun(repo);
    queued(repo, { state: 'dispatched', runId: 'SOMEONE-ELSE' });
    expect('cleaned' in (await clean(repo, end.runId))).toBe(true);
  });
});

test('an open pull request from the branch refuses the clean, naming it', async () => {
  await withTempRepo(async (repo) => {
    const { end, branch } = await failedRun(repo);
    const adapters = await fakeAdapters(repo.dir);
    await adapters.ports.codeHost.push(repo.dir, branch);
    const pr = await adapters.ports.codeHost.openPullRequest({
      base: 'main',
      head: branch,
      title: 'Add a shout flag',
      body: 'Adds it.',
    });
    const refused = refusal(await clean(repo, end.runId));
    expect(refused).toContain(`#${pr.number}`);
    expect(refused).toContain(pr.url);
    expect(existsSync(join(end.dir, 'workspace'))).toBe(true);
    expect(ref(repo, `refs/heads/${branch}`)).toBe(true);
  });
});

test('a run whose branch is not on the remote never asks for the code host', async () => {
  await withTempRepo(async (repo) => {
    const { end } = await failedRun(repo);
    const cleaned = await clean(repo, end.runId, {
      codeHost: async () => {
        throw new Error('the code host was asked');
      },
    });
    expect('cleaned' in cleaned).toBe(true);
  });
});

test('a code host that is refused refuses the run, since an unanswered check is no permission', async () => {
  await withTempRepo(async (repo) => {
    const { end, branch } = await failedRun(repo);
    repo.git('update-ref', `refs/heads/${branch}`, 'HEAD');
    const refused = refusal(await clean(repo, end.runId, { codeHost: async () => ({ refused: 'no GITHUB_TOKEN' }) }));
    expect(refused).toContain('no GITHUB_TOKEN');
    expect(existsSync(end.dir)).toBe(true);
    expect(ref(repo, `refs/heads/${branch}`)).toBe(true);
  });
});

test('worktree, local branch, remote branch and run ref are each removed and listed in that order; the run directory is archived under the sail home', async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const { end, branch } = await failedRun(repo);
    repo.git('update-ref', `refs/heads/${branch}`, 'HEAD');
    repo.git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
    repo.git('update-ref', `refs/sail/runs/${end.runId}`, 'HEAD');
    const workspace = createGitWorktreeWorkspace({
      repo: repo.dir,
      env: repo.env,
      leasesDir: join(repo.dir, '.sail-runs', 'fake', 'leases'),
    });
    const cleaned = await clean(repo, end.runId, { workspace });
    const archived = join(sailHome(repo), 'failed-runs', DAY, end.runId);
    expect(cleaned).toEqual({
      cleaned: { runId: end.runId, removed: ['worktree', `branch ${branch}`, 'remote branch', 'run ref'], archived },
    });
    expect(ref(repo, `refs/heads/${branch}`)).toBe(false);
    expect(ref(repo, `refs/sail/runs/${end.runId}`)).toBe(false);
    expect(
      Bun.spawnSync(['git', 'ls-remote', '--heads', 'origin', branch], {
        cwd: repo.dir,
        env: repo.env,
      }).stdout.toString(),
    ).toBe('');
    expect(
      Bun.spawnSync(['git', 'worktree', 'list'], { cwd: repo.dir, env: repo.env }).stdout.toString(),
    ).not.toContain(end.runId);
    expect(existsSync(join(archived, 'events.ndjson'))).toBe(true);
    expect(existsSync(join(archived, 'run.json'))).toBe(true);
    expect(existsSync(end.dir)).toBe(false);
  });
});

test("a run started from a pull request keeps the pull request's head branch, locally and on the remote, since sail did not make it", async () => {
  await withTempRepo(async (repo) => {
    withOrigin(repo);
    const { end, branch } = await failedRun(repo);
    const header = readRunHeader(end.dir);
    const headSha = repo.git('rev-parse', 'HEAD').trim();
    chmodSync(join(end.dir, 'run.json'), 0o644);
    writeFileSync(
      join(end.dir, 'run.json'),
      JSON.stringify({ ...header, source: { kind: 'pr', number: 7, headSha, via: 'cli', forced: [] } }),
    );
    repo.git('update-ref', `refs/heads/${branch}`, 'HEAD');
    repo.git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
    repo.git('update-ref', `refs/sail/runs/${end.runId}`, 'HEAD');
    const workspace = createGitWorktreeWorkspace({
      repo: repo.dir,
      env: repo.env,
      leasesDir: join(repo.dir, '.sail-runs', 'fake', 'leases'),
    });
    const cleaned = await clean(repo, end.runId, { workspace });
    expect(cleaned).toEqual({
      cleaned: {
        runId: end.runId,
        removed: ['worktree', 'run ref'],
        archived: join(sailHome(repo), 'failed-runs', DAY, end.runId),
      },
    });
    expect(ref(repo, `refs/heads/${branch}`)).toBe(true);
    expect(
      Bun.spawnSync(['git', 'ls-remote', '--heads', 'origin', branch], {
        cwd: repo.dir,
        env: repo.env,
      }).stdout.toString(),
    ).toContain(branch);
  });
});

test('what is already gone is skipped and not listed: a stopped run, whose worktree went with the stop, lists only the run ref', async () => {
  await withTempRepo(async (repo) => {
    const end = await suspendedRun(repo);
    await stopRun({ sailDir: sailDir(repo), runId: end.runId, adapters: await fakeAdapters(repo.dir) });
    repo.git('update-ref', `refs/sail/runs/${end.runId}`, 'HEAD');
    const cleaned = await clean(repo, end.runId);
    expect(cleaned).toEqual({
      cleaned: {
        runId: end.runId,
        removed: ['run ref'],
        archived: join(sailHome(repo), 'failed-runs', DAY, end.runId),
      },
    });
  });
});

test('a clean with nothing left to remove still archives the run directory, with its events and call logs', async () => {
  await withTempRepo(async (repo) => {
    const end = await suspendedRun(repo);
    await stopRun({ sailDir: sailDir(repo), runId: end.runId, adapters: await fakeAdapters(repo.dir) });
    const calls = readdirSync(end.dir).filter((name) => /^\d\d-/.test(name));
    const cleaned = await clean(repo, end.runId);
    const archived = join(sailHome(repo), 'failed-runs', DAY, end.runId);
    expect(cleaned).toEqual({ cleaned: { runId: end.runId, removed: [], archived } });
    expect(calls.length).toBeGreaterThan(0);
    expect(readdirSync(archived)).toEqual(expect.arrayContaining(['events.ndjson', ...calls]));
    expect(readdirSync(join(repo.dir, '.sail-runs'))).not.toContain(end.runId);
  });
});

test('an existing archive destination refuses the clean, with nothing removed', async () => {
  await withTempRepo(async (repo) => {
    const { end, branch } = await failedRun(repo);
    repo.git('update-ref', `refs/heads/${branch}`, 'HEAD');
    mkdirSync(join(sailHome(repo), 'failed-runs', DAY, end.runId), { recursive: true });
    const refused = refusal(await clean(repo, end.runId));
    expect(refused).toContain(join(sailHome(repo), 'failed-runs', DAY, end.runId));
    expect(existsSync(join(end.dir, 'workspace'))).toBe(true);
    expect(ref(repo, `refs/heads/${branch}`)).toBe(true);
  });
});

test('a removal that fails still lets the rest run, is reported and keeps the run directory; once its cause is gone a second clean finishes', async () => {
  await withTempRepo(async (repo) => {
    const { end, branch } = await failedRun(repo);
    repo.git('checkout', '--quiet', '-b', branch);
    repo.git('update-ref', `refs/sail/runs/${end.runId}`, 'HEAD');
    const first = await clean(repo, end.runId);
    expect(first).toMatchObject({
      failed: { runId: end.runId, removed: ['worktree', 'run ref'], dir: end.dir },
    });
    const failures = 'failed' in first ? first.failed.failures : [];
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`the branch ${branch} was not removed`);
    expect(existsSync(end.dir)).toBe(true);
    expect(existsSync(join(end.dir, 'workspace'))).toBe(false);
    expect(ref(repo, `refs/sail/runs/${end.runId}`)).toBe(false);

    repo.git('checkout', '--quiet', 'main');
    const second = await clean(repo, end.runId);
    expect(second).toEqual({
      cleaned: {
        runId: end.runId,
        removed: [`branch ${branch}`],
        archived: join(sailHome(repo), 'failed-runs', DAY, end.runId),
      },
    });
    expect(existsSync(end.dir)).toBe(false);
  });
});
