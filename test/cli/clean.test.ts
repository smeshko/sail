// `sail clean <run>... | --failed`: the selection, the exit codes of a refusal and of a failed removal, and a clean
// that never resolves the code host when the branch is not on the remote.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { writeStatus } from '../../src/engine/run-dir';
import { readRunHeader } from '../../src/engine/run-header';
import { runWorkflow } from '../../src/engine/runtime';
import { fakeAdapters } from '../helpers/adapters';
import { edit } from '../helpers/fixture';
import { withOrigin } from '../helpers/origin';
import { runCaptured } from '../helpers/run-captured';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const USAGE = 'sail clean: usage: sail clean <run>... | --failed\n';

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
