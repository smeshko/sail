// The Workspace port suite, run for the git-worktree adapter over a real origin and a clone of it, in temporary
// directories (ADR-0018): the same cases the fake runs, so the two adapters cannot drift apart. The suite's world puts
// runs under the clone's `.sail-runs/`, where a run's worktree goes.
import { afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitWorktreeWorkspace } from '../../../src/adapters/git-worktree/index';
import { writeStatus } from '../../../src/engine/run-dir';
import { type WorkspaceWorld, workspaceSuite } from '../../ports/workspace.suite';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp directory by its real path, removed after the test. */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-gw-suite-')));
  dirs.push(dir);
  return dir;
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
}

/** An origin with one commit on `main`, a clone of it, and the environment their git runs in. */
function pair() {
  const root = tempDir();
  const home = join(root, 'home');
  mkdirSync(home);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, env });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr}`);
    return { code: result.exitCode, stdout: result.stdout.toString().trim() };
  };
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-b', 'main');
  writeFileSync(join(origin, 'README.md'), '# origin\n');
  git(origin, 'add', 'README.md');
  git(origin, 'commit', '-m', 'initial');
  const clone = join(root, 'clone');
  git(root, 'clone', origin, clone);
  return { origin, clone, env, git };
}

workspaceSuite('git-worktree', async (emit) => {
  const { origin, clone, env, git } = pair();
  const leases = tempDir();
  const runsDir = join(clone, '.sail-runs');
  mkdirSync(runsDir);
  const world: WorkspaceWorld = {
    remote: origin,
    clone,
    base: 'origin/HEAD',
    baseSha: git(origin, 'rev-parse', 'HEAD').stdout,
    tracked: 'README.md',
    runsDir,
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
  return {
    adapter: createGitWorktreeWorkspace({ repo: clone, leasesDir: leases, env, emit }),
    world,
  };
});
