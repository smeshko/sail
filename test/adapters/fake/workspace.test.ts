// The fake Workspace port: the port suite over detached worktrees of a throwaway repository, then what only the fake
// does (D9, D12). Every git spawn gets the repository's env.
import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createFakeWorkspace } from '../../../src/adapters/fake/workspace';
import { defaultLeasesDir, readLease } from '../../../src/adapters/leases';
import { writeStatus } from '../../../src/engine/run-dir';
import { holdTempRepo } from '../../helpers/held-repo';
import { portFailure, rejection, settle } from '../../helpers/ports';
import { withTempRepo } from '../../helpers/temp-repo';
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
    base: 'main',
    defaultBranch: 'main',
    baseSha: git('rev-parse', 'main'),
    repoDir: repo().dir,
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
    publishBranch: (branch) => {
      const sha = git('commit-tree', 'main^{tree}', '-p', 'main', '-m', `work on ${branch}`);
      git('update-ref', `refs/heads/${branch}`, sha);
      return sha;
    },
  };
}

workspaceSuite('fake', async (emit) => {
  const w = world();
  return {
    adapter: createFakeWorkspace({ repo: repo().dir, remote: REMOTE, leasesDir: w.leasesDir, env: repo().env, emit }),
    world: w,
  };
});

test('the fake adapter emits nothing for a mark', async () => {
  const w = world();
  const events: unknown[] = [];
  const workspace = createFakeWorkspace({
    repo: repo().dir,
    leasesDir: w.leasesDir,
    env: repo().env,
    emit: (event) => {
      events.push(event);
    },
  });
  const holder = await w.run('r1', 'suspended');
  await workspace.lease(REMOTE, 'sail/mark', holder);
  events.length = 0;
  await workspace.lease(REMOTE, 'sail/mark', { ...holder, suspended: true });
  expect(events).toEqual([]);
  expect(readLease(w.leasesDir, REMOTE, 'sail/mark')?.suspended).toBe(true);
});

test("create from a base that doesn't resolve is invalid, and makes no workspace", async () => {
  const w = world();
  const workspace = createFakeWorkspace({ repo: repo().dir, leasesDir: w.leasesDir, env: repo().env });
  const run = await w.run('r1');
  const error = await rejection(workspace.create(run, { base: 'no-such-ref', branch: 'sail/FAKE-1' }));
  expect(portFailure(error)).toEqual({ port: 'workspace', op: 'create', code: 'invalid' });
  expect(existsSync(join(run.runDir, 'workspace'))).toBe(false);
});

test('with no leases directory named, a lease lands in ~/.sail/leases', async () => {
  const workspace = createFakeWorkspace({ repo: repo().dir, env: repo().env });
  const run = await world().run('r1');
  await workspace.lease(REMOTE, 'sail/default-dir', run);
  const held = readLease(defaultLeasesDir(), REMOTE, 'sail/default-dir')?.runId;
  await workspace.releaseLease(REMOTE, 'sail/default-dir', 'r1');
  expect([held, readLease(defaultLeasesDir(), REMOTE, 'sail/default-dir')]).toEqual(['r1', undefined]);
});

test('with SAIL_HOME in its env and no leases directory named, a lease lands in $SAIL_HOME/leases', async () => {
  await withTempRepo(async (repo) => {
    const home = join(repo.dir, '.machine');
    const workspace = createFakeWorkspace({ repo: repo.dir, env: { ...repo.env, SAIL_HOME: home } });
    const branch = 'sail/fake-home';
    try {
      await workspace.lease(REMOTE, branch, { runId: 'r1', runDir: join(repo.dir, 'r1'), pid: process.pid });
      expect(readLease(join(home, 'leases'), REMOTE, branch)?.runId).toBe('r1');
      expect(readLease(join(homedir(), '.sail', 'leases'), REMOTE, branch)).toBeUndefined();
    } finally {
      await workspace.releaseLease(REMOTE, branch, 'r1');
    }
    expect(readLease(join(home, 'leases'), REMOTE, branch)).toBeUndefined();
  });
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

test('the fake reports fake://origin and main unless told otherwise, and starts a workspace from the branch it names', async () => {
  const w = world();
  repo().git('branch', '-f', 'trunk', 'main');
  const defaults = createFakeWorkspace({ repo: repo().dir, leasesDir: w.leasesDir, env: repo().env });
  const told = createFakeWorkspace({
    repo: repo().dir,
    remote: 'fake://elsewhere',
    defaultBranch: 'trunk',
    leasesDir: w.leasesDir,
    env: repo().env,
  });
  const bare = async (adapter: typeof told) => {
    const repository = await settle(adapter.repository());
    return 'rejected' in repository ? repository : { url: repository.url, defaultBranch: repository.defaultBranch };
  };
  const created = await settle(told.create(await w.run('r1'), { branch: 'sail/FAKE-1' }));
  expect({
    defaults: await bare(defaults),
    told: await bare(told),
    base: 'rejected' in created ? created : created.baseSha,
  }).toEqual({
    defaults: { url: 'fake://origin', defaultBranch: 'main' },
    told: { url: 'fake://elsewhere', defaultBranch: 'trunk' },
    base: repo().git('rev-parse', 'trunk'),
  });
});

test('a workspace git no longer knows is still removed, and nothing beside it in the run directory is', async () => {
  const w = world();
  const workspace = createFakeWorkspace({ repo: repo().dir, leasesDir: w.leasesDir, env: repo().env });
  const run = await w.run('r1');
  const { path } = await workspace.create(run, { base: 'main', branch: 'sail/FAKE-1' });
  // git can't remove what it no longer takes for a worktree: the plain removal has to.
  unlinkSync(join(path, '.git'));
  writeFileSync(join(path, 'left.txt'), 'left behind\n');
  mkdirSync(join(run.runDir, 'workspace-notes'));
  writeFileSync(join(run.runDir, 'workspace-notes', 'keep.txt'), 'keep\n');
  writeFileSync(join(run.runDir, 'keep.txt'), 'keep\n');
  const released = await settle(workspace.release(run, false));
  expect({
    released: 'rejected' in released ? released : released.kept,
    workspace: existsSync(path),
    beside: [
      readFileSync(join(run.runDir, 'workspace-notes', 'keep.txt'), 'utf8'),
      readFileSync(join(run.runDir, 'keep.txt'), 'utf8'),
    ],
  }).toEqual({ released: false, workspace: false, beside: ['keep\n', 'keep\n'] });
});

test('fastForward answers moved false: the fake repository stands in for the remote', async () => {
  const workspace = createFakeWorkspace({ repo: repo().dir, env: repo().env, leasesDir: tempDir() });
  expect(await workspace.fastForward?.()).toEqual({ moved: false });
});
