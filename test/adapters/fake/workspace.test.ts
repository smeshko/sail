// The fake Workspace port: the port suite over detached worktrees of a throwaway repository, then what only the fake
// does (D9, D12). Every git spawn gets the repository's env.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeWorkspace } from '../../../src/adapters/fake/workspace';
import { defaultLeasesDir, readLease } from '../../../src/adapters/leases';
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

test('with no leases directory named, a lease lands in ~/.sail/leases', async () => {
  const workspace = createFakeWorkspace({ repo: repo().dir, env: repo().env });
  const run = await world().run('r1');
  await workspace.lease(REMOTE, 'sail/default-dir', run);
  const held = readLease(defaultLeasesDir(), REMOTE, 'sail/default-dir')?.runId;
  await workspace.releaseLease(REMOTE, 'sail/default-dir', 'r1');
  expect([held, readLease(defaultLeasesDir(), REMOTE, 'sail/default-dir')]).toEqual(['r1', undefined]);
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

test('the fake declares keep and sweep', () => {
  expect(createFakeWorkspace({ repo: repo().dir }).capabilities()).toEqual({ keep: true, sweep: true });
});
