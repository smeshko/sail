// `sail resume` of a run in its own worktree (TASK-009): it continues there under its lease, and refuses a worktree that
// is gone, a base commit that is no ancestor of the worktree's HEAD, or a lease a live run has taken over. The resume runs
// as a child process, as it would in a terminal: a process opens one run per `.sail/`, and the suspended run is in this one.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { readStatus, writeStatus } from '../../src/engine/run-dir';
import { readEvents } from '../../src/events/consumers/ndjson';
import { edit } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const REPO = join(import.meta.dir, '..', '..');
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Runs `bin/sail` with `args` in `cwd` as a child process, under `env`: its code, stdout and stderr. */
async function sailProcess(args: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn([join(REPO, 'bin', 'sail'), ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, stdout, stderr };
}

/** Runs git in `cwd` under `env`, giving its trimmed stdout. */
function gitIn(cwd: string, env: Record<string, string>, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr}`);
  return result.stdout.toString().trim();
}

/** The runs in `repoDir`'s `.sail-runs/`, or none: the fake adapters keep their own state under `fake/`. */
const runIds = (repoDir: string): string[] =>
  existsSync(join(repoDir, '.sail-runs'))
    ? readdirSync(join(repoDir, '.sail-runs')).filter((name) => name !== 'fake')
    : [];

/** The lease file of the one lease in a HOME, as its JSON text path. */
function leaseFileUnder(home: string): string {
  const dir = join(home, '.sail', 'leases');
  const [file] = readdirSync(dir).filter((name) => name.endsWith('.json'));
  return join(dir, file ?? '');
}

/**
 * A stub repository whose origin is a repository of its own, with `origin/HEAD` set and workspace on git-worktree, run to
 * `--until tests`, so its run is suspended with its worktree and its lease. `check` gets the repository and the run's id.
 */
async function suspendedInWorktree(check: (repo: TempRepo, runId: string) => Promise<void>): Promise<void> {
  await withTempRepo(async (origin) => {
    await withTempRepo(async (repo) => {
      repo.git('remote', 'add', 'origin', origin.dir);
      repo.git('fetch', 'origin');
      repo.git('remote', 'set-head', 'origin', '-a');
      const sail = writeStub(repo.dir);
      edit(sail, 'project.yaml', 'workspace: { use: fake }', 'workspace: { use: git-worktree }');
      const stopped = await runCaptured(['FAKE-1', '--until', 'tests'], repo.dir, { env: repo.env });
      expect(stopped.code).toBe(EXIT_SUSPENDED);
      // `runCaptured` runs the suspending sail in this process, which then stays alive. A real suspended run's process has
      // exited, so its lease names a pid no process has: the lease is rewritten to one, as the exit would have left it.
      const file = leaseFileUnder(repo.env.HOME ?? '');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/"pid": ?\d+/, '"pid": 999999'));
      const [runId] = runIds(repo.dir);
      await check(repo, runId ?? '');
    });
  });
}

// STICKER: each case below is one of ADW-93's TASK-009 cases. The sticker names the task that makes it pass.

test('sail resume continues a suspended run in its own worktree, and the worktree is the one the run releases at its end', async () => {
  await suspendedInWorktree(async (repo, runId) => {
    const resumed = await sailProcess(['resume', runId], repo.dir, repo.env);
    const released = readEvents(join(repo.dir, '.sail-runs', runId)).filter(
      (event) => event.type === 'workspace:released',
    ) as { path?: string; kept?: boolean }[];
    expect({ code: resumed.code, released: released.map(({ path, kept }) => ({ path, kept })) }).toEqual({
      code: EXIT_OK,
      // The suspension kept the worktree, then the resumed run released it at its end.
      released: [
        { path: `.sail-runs/${runId}/workspace`, kept: true },
        { path: `.sail-runs/${runId}/workspace`, kept: false },
      ],
    });
  });
}, 15_000);

test('a resume whose worktree was deleted is refused with exit 3, and the run stays suspended', async () => {
  await suspendedInWorktree(async (repo, runId) => {
    rmSync(join(repo.dir, '.sail-runs', runId, 'workspace'), { recursive: true, force: true });
    const resumed = await sailProcess(['resume', runId], repo.dir, repo.env);
    expect({
      code: resumed.code,
      status: readStatus(join(repo.dir, '.sail-runs', runId)).status,
    }).toEqual({ code: EXIT_REFUSED, status: 'suspended' });
  });
});

test("a resume whose run.json names the clone as the run's workspace is refused with exit 3, and the run stays suspended", async () => {
  await suspendedInWorktree(async (repo, runId) => {
    const runDir = join(repo.dir, '.sail-runs', runId);
    const file = join(runDir, 'run.json');
    chmodSync(file, 0o644);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), workspace: '.' }));
    const resumed = await sailProcess(['resume', runId], repo.dir, repo.env);
    expect({ code: resumed.code, status: readStatus(runDir).status }).toEqual({
      code: EXIT_REFUSED,
      status: 'suspended',
    });
  });
});

test("a resume whose run.json names no workspace is refused with exit 3, and the run stays suspended", async () => {
  await suspendedInWorktree(async (repo, runId) => {
    const runDir = join(repo.dir, '.sail-runs', runId);
    const file = join(runDir, 'run.json');
    chmodSync(file, 0o644);
    const { workspace: _named, ...header } = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify(header));
    const resumed = await sailProcess(['resume', runId], repo.dir, repo.env);
    expect({ code: resumed.code, status: readStatus(runDir).status }).toEqual({ code: EXIT_REFUSED, status: 'suspended' });
  });
});

test('a resume whose worktree is replaced by a plain directory is refused with exit 3, and the run stays suspended', async () => {
  await suspendedInWorktree(async (repo, runId) => {
    const runDir = join(repo.dir, '.sail-runs', runId);
    rmSync(join(runDir, 'workspace'), { recursive: true, force: true });
    mkdirSync(join(runDir, 'workspace'));
    const resumed = await sailProcess(['resume', runId], repo.dir, repo.env);
    expect({ code: resumed.code, status: readStatus(runDir).status }).toEqual({
      code: EXIT_REFUSED,
      status: 'suspended',
    });
  });
});

test("a resume whose baseSha is no ancestor of the worktree's HEAD is refused with exit 3, naming both commits", async () => {
  await suspendedInWorktree(async (repo, runId) => {
    const runDir = join(repo.dir, '.sail-runs', runId);
    const baseSha: string = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).repository.baseSha;
    // A commit with no parent, made in the clone's object store and checked out in the worktree: the base is not in it.
    const orphan = gitIn(repo.dir, repo.env, 'commit-tree', EMPTY_TREE, '-m', 'an unrelated commit');
    gitIn(join(runDir, 'workspace'), repo.env, 'checkout', '--detach', orphan);
    const resumed = await sailProcess(['resume', runId], repo.dir, repo.env);
    expect([resumed.code, resumed.stderr.includes(baseSha), resumed.stderr.includes(orphan)]).toEqual([
      EXIT_REFUSED,
      true,
      true,
    ]);
  });
});

test('a resume whose lease a live run has taken over is refused with exit 3, naming that run', async () => {
  await suspendedInWorktree(async (repo, runId) => {
    const other = join(repo.dir, '.sail-runs', 'FAKE-1-01TAKENOVERBYANOTHERRUN');
    mkdirSync(other, { recursive: true });
    writeStatus(other, 'running');
    const file = leaseFileUnder(repo.home);
    const lease = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(
      file,
      JSON.stringify({ ...lease, runId: 'FAKE-1-01TAKENOVERBYANOTHERRUN', runDir: other, pid: process.pid }),
    );
    const resumed = await sailProcess(['resume', runId], repo.dir, repo.env);
    expect([resumed.code, resumed.stderr.includes('FAKE-1-01TAKENOVERBYANOTHERRUN')]).toEqual([EXIT_REFUSED, true]);
  });
});

test('a resume renews its own lease under its run id, and the stream reports the renewal without a takeover', async () => {
  await suspendedInWorktree(async (repo, runId) => {
    const resumed = await sailProcess(['resume', runId], repo.dir, repo.env);
    const leased = readEvents(join(repo.dir, '.sail-runs', runId)).filter((event) => event.type === 'workspace:leased');
    expect({
      code: resumed.code,
      leases: leased.length,
      tookOnRenewal: (leased.at(-1) as { took?: string } | undefined)?.took,
    }).toEqual({
      code: EXIT_OK,
      leases: 2,
      tookOnRenewal: undefined,
    });
  });
});
