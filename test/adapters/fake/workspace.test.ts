// The fake Workspace port: the port suite over detached worktrees of a throwaway repository, then what only the fake
// does (D9, D12). Every git spawn gets the repository's env.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createFakeWorkspace } from '../../../src/adapters/fake/workspace';
import { readLease } from '../../../src/adapters/leases';
import { writeStatus } from '../../../src/engine/run-dir';
import { holdTempRepo } from '../../helpers/held-repo';
import { portFailure, rejection } from '../../helpers/ports';
import { type WorkspaceWorld, workspaceSuite } from '../../ports/workspace.suite';

const REMOTE = 'fake://codehost/fixture';
const repo = holdTempRepo();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp directory by its real path, as git reports worktree paths. */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-fake-workspace-')));
  dirs.push(dir);
  return dir;
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
}

/** A world over the held repository, with runs and leases of its own. */
function world(): WorkspaceWorld & { leasesDir: string } {
  const { env, git } = repo();
  const runsDir = tempDir();
  return {
    remote: REMOTE,
    clone: repo().dir,
    base: 'main',
    baseSha: git('rev-parse', 'main'),
    tracked: 'README.md',
    runsDir,
    leasesDir: tempDir(),
    run: async (runId, status = 'running', alive = true) => {
      const runDir = join(runsDir, runId);
      mkdirSync(runDir);
      if (status === 'failed') writeStatus(runDir, status, 'workflow_failed');
      else if (status === 'suspended') writeStatus(runDir, status, 'interrupted');
      else if (status !== 'none') writeStatus(runDir, status);
      return { runId, runDir, pid: alive ? process.pid : await deadPid() };
    },
    git: (cwd, ...args) => {
      const result = Bun.spawnSync(['git', ...args], { cwd, env });
      return { code: result.exitCode, stdout: result.stdout.toString().trim() };
    },
  };
}

workspaceSuite('fake', async (emit) => {
  const w = world();
  return {
    adapter: createFakeWorkspace({ repo: repo().dir, leasesDir: w.leasesDir, env: repo().env, emit }),
    world: w,
  };
});

test("create from a base that doesn't resolve is invalid, and makes no workspace", async () => {
  const w = world();
  const workspace = createFakeWorkspace({ repo: repo().dir, leasesDir: w.leasesDir, env: repo().env });
  const run = await w.run('r1');
  const error = await rejection(workspace.create(run, { base: 'no-such-ref', branch: 'sail/FAKE-1' }));
  expect(portFailure(error)).toEqual({ port: 'workspace', op: 'create', code: 'invalid' });
  expect(existsSync(join(run.runDir, 'workspace'))).toBe(false);
});

test("with no leases directory named, a lease lands under the environment's HOME, in its .sail/leases", async () => {
  const { env } = repo();
  const leases = join(env.HOME ?? '', '.sail', 'leases');
  const workspace = createFakeWorkspace({ repo: repo().dir, env });
  const run = await world().run('r1');
  await workspace.lease(REMOTE, 'sail/default-dir', run);
  const held = readLease(leases, REMOTE, 'sail/default-dir')?.runId;
  await workspace.releaseLease(REMOTE, 'sail/default-dir', 'r1');
  expect([held, readLease(leases, REMOTE, 'sail/default-dir')]).toEqual(['r1', undefined]);
});

test('a released workspace is gone from git worktree list too', async () => {
  const w = world();
  const workspace = createFakeWorkspace({ repo: repo().dir, leasesDir: w.leasesDir, env: repo().env });
  const run = await w.run('r1');
  const { path } = await workspace.create(run, { base: 'main', branch: 'sail/FAKE-1' });
  const listed = () => repo().git('worktree', 'list', '--porcelain').split('\n').includes(`worktree ${path}`);
  const before = listed();
  await workspace.release(run, false);
  expect([before, listed()]).toEqual([true, false]);
});

test("a relative run directory is the caller's, not the stand-in repository's: the workspace lands, diffs and goes there", async () => {
  const w = world();
  const workspace = createFakeWorkspace({ repo: repo().dir, leasesDir: w.leasesDir, env: repo().env });
  const absolute = await w.run('r1');
  const run = { ...absolute, runDir: relative(process.cwd(), absolute.runDir) };
  const created = await workspace.create(run, { base: 'main', branch: 'sail/FAKE-1' });
  expect(created.path).toBe(join(run.runDir, 'workspace'));
  expect(w.git(join(absolute.runDir, 'workspace'), 'rev-parse', 'HEAD')).toEqual({ code: 0, stdout: created.baseSha });
  expect((await workspace.diff(created.path, created.baseSha)).patch).toBe('');
  await workspace.release(run, false);
  expect(existsSync(join(absolute.runDir, 'workspace'))).toBe(false);
});

test('the fake declares keep and sweep', () => {
  expect(createFakeWorkspace({ repo: repo().dir }).capabilities()).toEqual({ keep: true, sweep: true });
});

// STICKER: the fake's lease remote is the fixed name `fake` for any clone, so its events and run files hold no path.
test("the fake keys its leases on the remote named fake, whatever the clone's path", async () => {
  const workspace = createFakeWorkspace({ repo: repo().dir });
  expect([await workspace.remoteKey(repo().dir), await workspace.remoteKey(tempDir())]).toEqual(['fake', 'fake']);
});

// STICKER: the engine asks for `origin/HEAD` as the base of every run, and the fake has no origin: it bases on HEAD.
// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ("a base of origin/HEAD in a repository with no origin is the repository's HEAD, so the fake's runs are based on it", async () => {
    const w = world();
    const workspace = createFakeWorkspace({ repo: repo().dir, leasesDir: w.leasesDir, env: repo().env });
    const run = await w.run('r1');
    const made = await workspace.create(run, { base: 'origin/HEAD', branch: 'sail/FAKE-1' }).then(
      (workspace) => workspace,
      (error: unknown) => String(error),
    );
    expect(made).toMatchObject({ baseSha: w.baseSha, path: join(run.runDir, 'workspace') });
  });
