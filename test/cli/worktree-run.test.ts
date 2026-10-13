// `sail FAKE-1` on a git-worktree workspace, in process through run(): the refusals a lease and a missing origin bring
// (TASK-005, TASK-006), a run that works in its own worktree and leaves the clone as it was (TASK-007). Each case has a
// temp repository and HOME of its own, so the leases a case takes are its own: a second command that must meet a lease
// runs in a copy of the first repository, with the first one's HOME.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { readEvents } from '../../src/events/consumers/ndjson';
import { edit } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { copyRun, writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

/** The runs in `repoDir`'s `.sail-runs/`: every entry but `fake/`, where the fake adapters keep their state. */
const runIds = (repoDir: string): string[] =>
  existsSync(join(repoDir, '.sail-runs'))
    ? readdirSync(join(repoDir, '.sail-runs')).filter((name) => name !== 'fake')
    : [];

/** The lease files under a HOME, which is where the leases of runs started with that HOME live. */
const leasesUnder = (home: string): string[] => {
  const dir = join(home, '.sail', 'leases');
  return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith('.json')) : [];
};

/** The tracked files' status lines: an untracked `.sail/` or `.sail-runs/` is not the clone's own state. */
const trackedStatus = (repo: TempRepo): string[] =>
  repo
    .git('status', '--porcelain')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('??'));

/**
 * A stub repository whose origin is a repository of its own, with `origin/HEAD` set, and whose workspace is git-worktree:
 * the workspace a run makes is a detached worktree of origin's default branch.
 */
async function withOriginRepo(check: (repo: TempRepo, origin: TempRepo) => Promise<void>): Promise<void> {
  await withTempRepo(async (origin) => {
    await withTempRepo(async (repo) => {
      repo.git('remote', 'add', 'origin', origin.dir);
      repo.git('fetch', 'origin');
      repo.git('remote', 'set-head', 'origin', '-a');
      const sail = writeStub(repo.dir);
      edit(sail, 'project.yaml', 'workspace: { use: fake }', 'workspace: { use: git-worktree }');
      await check(repo, origin);
    });
  });
}

// STICKER: each case below is part of ADW-93's TASK-005 to TASK-007. The sticker names the task that makes it pass.

test('sail FAKE-1 on a clone with no origin, configured for git-worktree, is refused with exit 3 naming origin, and nothing is written', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(sail, 'project.yaml', 'workspace: { use: fake }', 'workspace: { use: git-worktree }');
    const captured = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
    expect([captured.code, captured.stderr.includes('origin'), runIds(repo.dir)]).toEqual([EXIT_REFUSED, true, []]);
  });
});

test('sail FAKE-1 --force while a suspended run leases its branch is refused with exit 3, naming that run, with no run directory of its own', async () => {
  await withTempRepo(async (first) => {
    writeStub(first.dir);
    const suspended = await runCaptured(['FAKE-1', '--until', 'tests'], first.dir, { env: first.env });
    expect(suspended.code).toBe(EXIT_SUSPENDED);
    const [firstRun] = runIds(first.dir);
    await withTempRepo(async (second) => {
      copyRun(first.dir, second.dir);
      const forced = await runCaptured(['FAKE-1', '--force'], second.dir, { env: first.env });
      expect([forced.code, forced.stderr.includes(firstRun ?? 'no run'), runIds(second.dir)]).toEqual([
        EXIT_REFUSED,
        true,
        [firstRun ?? 'no run'],
      ]);
    });
  });
});

test('a run takes over the lease a completed run left, and its stream says which run it took it from', async () => {
  await withTempRepo(async (first) => {
    writeStub(first.dir);
    const done = await runCaptured(['FAKE-1'], first.dir, { env: first.env });
    expect(done.code).toBe(EXIT_OK);
    const [firstRun] = runIds(first.dir);
    await withTempRepo(async (second) => {
      copyRun(first.dir, second.dir);
      const again = await runCaptured(['FAKE-1', '--force'], second.dir, { env: first.env });
      const secondRun = runIds(second.dir).find((id) => id !== firstRun) ?? '';
      const leased = readEvents(join(second.dir, '.sail-runs', secondRun)).find(
        (event) => event.type === 'workspace:leased',
      ) as { took?: string } | undefined;
      expect([again.code, leased?.took]).toEqual([EXIT_OK, firstRun]);
    });
  });
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail FAKE-1 --until tests in a clone with an origin works in a worktree under .sail-runs, recorded in run.json with the base commit origin has', async () => {
    await withOriginRepo(async (repo, origin) => {
      const head = repo.git('rev-parse', 'HEAD');
      const stopped = await runCaptured(['FAKE-1', '--until', 'tests'], repo.dir, { env: repo.env });
      expect(stopped.code).toBe(EXIT_SUSPENDED);
      const [runId] = runIds(repo.dir);
      const header = JSON.parse(readFileSync(join(repo.dir, '.sail-runs', runId ?? '', 'run.json'), 'utf8'));
      expect({
        code: stopped.code,
        workspace: header.workspace,
        baseSha: header.repository?.baseSha,
        head: repo.git('rev-parse', 'HEAD'),
        listed: repo
          .git('worktree', 'list', '--porcelain')
          .includes(`worktree ${join(repo.dir, '.sail-runs', runId ?? '', 'workspace')}`),
      }).toEqual({
        code: EXIT_SUSPENDED,
        workspace: `.sail-runs/${runId}/workspace`,
        baseSha: origin.git('rev-parse', 'HEAD'),
        head,
        listed: true,
      });
    });
  }, 60_000);

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ("with an uncommitted edit and another branch checked out in the clone, sail FAKE-1 still runs to completion, and the clone is as it was left", async () => {
    await withOriginRepo(async (repo) => {
      repo.git('checkout', '-b', 'feature/other');
      writeFileSync(join(repo.dir, 'README.md'), 'an edit in the clone\n');
      const head = repo.git('rev-parse', 'HEAD');
      const status = trackedStatus(repo);
      const done = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
      expect([
        done.code,
        repo.git('rev-parse', 'HEAD'),
        trackedStatus(repo),
        readFileSync(join(repo.dir, 'README.md'), 'utf8'),
      ]).toEqual([EXIT_OK, head, status, 'an edit in the clone\n']);
    });
  }, 60_000);

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a worktree that cannot be made after the claim leaves no run directory and no lease, and says where the ticket stands', async () => {
    await withOriginRepo(async (repo) => {
      repo.git('remote', 'set-head', 'origin', '-d');
      const failed = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
      expect([
        failed.code !== EXIT_OK,
        failed.stderr.includes('In Progress'),
        runIds(repo.dir),
        leasesUnder(repo.home),
      ]).toEqual([true, true, [], []]);
    });
  });
