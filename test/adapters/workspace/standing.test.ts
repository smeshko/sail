// Standing workspaces: where one lives and who holds it.
import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitSync } from '../../../src/adapters/workspace/git';
import {
  dropStanding,
  heldByRun,
  readStanding,
  STANDING_DIR,
  standingDir,
  standingOf,
  standingPath,
  takeStanding,
} from '../../../src/adapters/workspace/standing';
import { leaseStanding, releaseStanding, reopenStanding } from '../../../src/adapters/workspace/standing-tree';
import { type Status, writeStatus } from '../../../src/engine/run-dir';
import type { RunRef } from '../../../src/ports/workspace';
import { type TempRepo, withTempRepo } from '../../helpers/temp-repo';

const NOW = new Date('2026-11-01T09:00:00.000Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-standing-'));
  dirs.push(dir);
  return dir;
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
}

/** A holder for run `runId` whose run directory holds `status` (none when left out), and whose pid is `pid`. */
function holder(runId: string, pid: number, status?: Status, withDir = true) {
  const runDir = join(tempDir(), runId);
  if (withDir) {
    mkdirSync(runDir);
    if (status === 'failed') writeStatus(runDir, status, 'workflow_failed');
    else if (status === 'suspended') writeStatus(runDir, status, 'interrupted');
    else if (status !== undefined) writeStatus(runDir, status);
  }
  return { runId, runDir, pid };
}

test('a free standing directory is taken, a second run is refused it naming the holder, and the holder renews it', () => {
  const dir = standingDir(tempDir(), 'demo', 0);
  const first = holder('run-a', process.pid);
  expect(takeStanding(dir, first, NOW)).toEqual({ taken: true });
  const second = takeStanding(dir, holder('run-b', process.pid), NOW);
  expect(second.taken).toBe(false);
  if (!second.taken) expect(second.holder.runId).toBe('run-a');
  expect(takeStanding(dir, { ...first, pid: process.pid + 1 }, NOW)).toEqual({ taken: true });
  expect(readStanding(dir)?.pid).toBe(process.pid + 1);
});

test('a lease whose run completed or failed is taken over, and took names that run', () => {
  for (const status of ['completed', 'failed'] as const) {
    const dir = standingDir(tempDir(), 'demo', 0);
    takeStanding(dir, holder('old', process.pid, status), NOW);
    const result = takeStanding(dir, holder('new', process.pid), NOW);
    expect(result.taken).toBe(true);
    if (result.taken) expect(result.took?.runId).toBe('old');
    expect(readStanding(dir)?.runId).toBe('new');
  }
});

test('a lease whose run is suspended, or running with a dead pid, is refused', async () => {
  const dead = await deadPid();
  for (const status of ['suspended', 'running'] as const) {
    const dir = standingDir(tempDir(), 'demo', 0);
    takeStanding(dir, holder('old', dead, status), NOW);
    const result = takeStanding(dir, holder('new', process.pid), NOW);
    expect(result.taken).toBe(false);
    expect(readStanding(dir)?.runId).toBe('old');
  }
});

test('a lease with no run directory and a dead pid is taken over, with a live pid it is held', async () => {
  const dead = await deadPid();
  const dir = standingDir(tempDir(), 'demo', 0);
  takeStanding(dir, holder('old', dead, undefined, false), NOW);
  expect(takeStanding(dir, holder('new', process.pid), NOW).taken).toBe(true);
  const other = standingDir(tempDir(), 'demo', 0);
  takeStanding(other, holder('old', process.pid, undefined, false), NOW);
  expect(takeStanding(other, holder('new', process.pid), NOW).taken).toBe(false);
});

test('dropStanding by a run that does not hold the lease leaves it', () => {
  const dir = standingDir(tempDir(), 'demo', 0);
  takeStanding(dir, holder('run-a', process.pid), NOW);
  expect(dropStanding(dir, 'run-b')).toBe(false);
  expect(heldByRun(dir, 'run-a')).toBe(true);
  expect(dropStanding(dir, 'run-a')).toBe(true);
  expect(existsSync(join(dir, 'LEASE'))).toBe(false);
  expect(heldByRun(dir, 'run-a')).toBe(false);
});

test('standingPath is the workspace folder of a standing directory', () => {
  const runs = tempDir();
  expect(standingPath(runs, 'demo', 1)).toBe(join(runs, STANDING_DIR, 'demo-1', 'workspace'));
  expect(standingOf(runs, standingPath(runs, 'demo', 1))).toBe(standingDir(runs, 'demo', 1));
});

test('standingOf is undefined for a run workspace, a path outside standing/ and one nested deeper', () => {
  const runs = tempDir();
  expect(standingOf(runs, join(runs, 'ADW-1-x', 'workspace'))).toBeUndefined();
  expect(standingOf(runs, join(runs, 'elsewhere', 'demo-0', 'workspace'))).toBeUndefined();
  expect(standingOf(runs, join(runs, STANDING_DIR, 'demo-0', 'deeper', 'workspace'))).toBeUndefined();
  expect(standingOf(runs, join(runs, STANDING_DIR, 'workspace'))).toBeUndefined();
  expect(standingOf(runs, join(runs, STANDING_DIR, 'demo-0', 'other'))).toBeUndefined();
});

// ---- Leasing a worktree in place ----

/** A repository whose commit tracks `tracked.txt` and ignores `cache/`, and a runs directory in it. */
async function standingRepo<T>(
  fn: (ctx: { repo: TempRepo; runsDir: string; sha: string; next: (id: string, status?: Status) => RunRef }) => T,
): Promise<T> {
  return withTempRepo(async (repo) => {
    writeFileSync(join(repo.dir, '.gitignore'), 'cache/\n.sail-runs/\n');
    writeFileSync(join(repo.dir, 'tracked.txt'), 'committed\n');
    repo.git('add', '.gitignore', 'tracked.txt');
    repo.git('commit', '-m', 'tracked');
    const runsDir = join(repo.dir, '.sail-runs');
    mkdirSync(runsDir);
    const next = (id: string, status?: Status): RunRef => {
      const runDir = join(runsDir, id);
      mkdirSync(runDir, { recursive: true });
      if (status === 'failed') writeStatus(runDir, status, 'workflow_failed');
      else if (status === 'suspended') writeStatus(runDir, status, 'interrupted');
      else if (status !== undefined) writeStatus(runDir, status);
      return { runId: id, runDir, workflow: 'demo', maxConcurrentRuns: 2 };
    };
    return fn({ repo, runsDir, sha: repo.git('rev-parse', 'HEAD'), next });
  });
}

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

test('a second lease after a release gets the same path: the ignored file stays, tracked files are as committed, untracked files and directories are gone', async () => {
  await standingRepo(({ repo, runsDir, sha, next }) => {
    const first = leaseStanding({ repo: repo.dir, run: next('run-a'), sha, env: repo.env });
    expect(first?.path).toBe(standingPath(runsDir, 'demo', 0));
    const path = first?.path ?? '';
    mkdirSync(join(path, 'cache'));
    writeFileSync(join(path, 'cache', 'warm'), 'warm');
    writeFileSync(join(path, 'tracked.txt'), 'changed\n');
    writeFileSync(join(path, 'left.txt'), 'left');
    mkdirSync(join(path, 'leftdir'));
    writeFileSync(join(path, 'leftdir', 'f'), 'f');
    releaseStanding(repo.dir, next('run-a', 'completed'), path, repo.env);

    const second = leaseStanding({ repo: repo.dir, run: next('run-b'), sha, env: repo.env });
    expect(second?.path).toBe(path);
    expect(read(path, 'cache', 'warm')).toBe('warm');
    expect(read(path, 'tracked.txt')).toBe('committed\n');
    expect(existsSync(join(path, 'left.txt'))).toBe(false);
    expect(existsSync(join(path, 'leftdir'))).toBe(false);
  });
});

test('a worktree left in a conflicted merge is clean at the new commit after the next lease', async () => {
  await standingRepo(({ repo, runsDir, sha, next }) => {
    const path = leaseStanding({ repo: repo.dir, run: next('run-a'), sha, env: repo.env })?.path ?? '';
    const git = (...args: string[]) => gitSync(path, args, repo.env);
    git('checkout', '-q', '-b', 'side');
    writeFileSync(join(path, 'tracked.txt'), 'side\n');
    git('commit', '-qam', 'side');
    git('checkout', '-q', '--detach', sha);
    writeFileSync(join(path, 'tracked.txt'), 'main\n');
    git('commit', '-qam', 'main');
    expect(git('merge', 'side').code).not.toBe(0);
    expect(git('status', '--porcelain').stdout).toContain('UU tracked.txt');
    writeStatus(next('run-a').runDir, 'completed');

    const again = leaseStanding({ repo: repo.dir, run: next('run-b'), sha, env: repo.env });
    expect(again?.path).toBe(standingPath(runsDir, 'demo', 0));
    expect(git('status', '--porcelain').stdout).toBe('');
    expect(git('rev-parse', 'HEAD').stdout.trim()).toBe(sha);
    expect(existsSync(join(path, '.git'))).toBe(true);
  });
});

test('a worktree left mid-rebase, mid-cherry-pick or mid-revert has none of it left after the next lease', async () => {
  await standingRepo(({ repo, sha, next }) => {
    const path = leaseStanding({ repo: repo.dir, run: next('run-a'), sha, env: repo.env })?.path ?? '';
    const git = (...args: string[]) => gitSync(path, args, repo.env);
    git('checkout', '-q', '-b', 'side');
    writeFileSync(join(path, 'tracked.txt'), 'side\n');
    git('commit', '-qam', 'side');
    const side = git('rev-parse', 'HEAD').stdout.trim();
    git('checkout', '-q', '-b', 'mine', sha);
    writeFileSync(join(path, 'tracked.txt'), 'main\n');
    git('commit', '-qam', 'main');
    const gitDir = git('rev-parse', '--absolute-git-dir').stdout.trim();
    // The run that holds the lease completes, and the next one leases the same worktree.
    const after = (holderId: string, nextId: string) => {
      writeStatus(next(holderId).runDir, 'completed');
      const again = leaseStanding({ repo: repo.dir, run: next(nextId), sha, env: repo.env });
      expect(again?.path).toBe(path);
      expect(git('status').stdout).not.toMatch(/rebase|cherry-pick|revert/);
      for (const state of ['rebase-merge', 'rebase-apply', 'sequencer', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
        expect(existsSync(join(gitDir, state))).toBe(false);
      }
      expect(git('rev-parse', 'HEAD').stdout.trim()).toBe(sha);
    };
    expect(git('rebase', side).code).not.toBe(0);
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(true);
    after('run-a', 'run-b');
    expect(git('rebase', side).code).not.toBe(128);

    git('rebase', '--abort');
    git('checkout', '-q', '--force', 'mine');
    expect(git('cherry-pick', side).code).not.toBe(0);
    expect(existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))).toBe(true);
    after('run-b', 'run-c');
  });
});

test('a lease taken over from a failed run keeps that run head at its run ref before the checkout', async () => {
  await standingRepo(({ repo, sha, next }) => {
    const old = next('run-a');
    const path = leaseStanding({ repo: repo.dir, run: old, sha, env: repo.env })?.path ?? '';
    // run.json records the base, as a started run's header does.
    writeFileSync(join(old.runDir, 'run.json'), JSON.stringify({ repository: { baseSha: sha } }));
    writeFileSync(join(path, 'tracked.txt'), 'work\n');
    gitSync(path, ['commit', '-qam', 'work'], repo.env);
    const head = gitSync(path, ['rev-parse', 'HEAD'], repo.env).stdout.trim();
    writeStatus(old.runDir, 'failed', 'workflow_failed');

    const taken = leaseStanding({ repo: repo.dir, run: next('run-b'), sha, env: repo.env });
    expect(taken?.raw.took?.runId).toBe('run-a');
    expect(repo.git('rev-parse', 'refs/sail/runs/run-a')).toBe(head);
    expect(gitSync(path, ['rev-parse', 'HEAD'], repo.env).stdout.trim()).toBe(sha);
  });
});

test('with every lease held, leaseStanding returns undefined and makes no directory beyond the cap', async () => {
  await standingRepo(({ repo, runsDir, sha, next }) => {
    const a = leaseStanding({ repo: repo.dir, run: next('run-a'), sha, env: repo.env });
    const b = leaseStanding({ repo: repo.dir, run: next('run-b'), sha, env: repo.env });
    expect([a?.path, b?.path]).toEqual([standingPath(runsDir, 'demo', 0), standingPath(runsDir, 'demo', 1)]);
    expect(leaseStanding({ repo: repo.dir, run: next('run-c'), sha, env: repo.env })).toBeUndefined();
    expect(readdirSync(join(runsDir, 'standing')).sort()).toEqual(['demo-0', 'demo-1']);
  });
});

test('a run that names no workflow gets no standing workspace', async () => {
  await standingRepo(({ repo, sha, next }) => {
    const { workflow: _workflow, ...bare } = next('run-a');
    expect(leaseStanding({ repo: repo.dir, run: bare, sha, env: repo.env })).toBeUndefined();
  });
});

test('a standing directory that holds a plain folder, not a worktree, is skipped and its lease dropped', async () => {
  await standingRepo(({ repo, runsDir, sha, next }) => {
    mkdirSync(standingPath(runsDir, 'demo', 0), { recursive: true });
    writeFileSync(join(standingPath(runsDir, 'demo', 0), 'mine.txt'), 'keep');
    const got = leaseStanding({ repo: repo.dir, run: next('run-a'), sha, env: repo.env });
    expect(got?.path).toBe(standingPath(runsDir, 'demo', 1));
    expect(existsSync(join(standingDir(runsDir, 'demo', 0), 'LEASE'))).toBe(false);
    expect(read(standingPath(runsDir, 'demo', 0), 'mine.txt')).toBe('keep');
  });
});

test('a link at a standing workspace or its directory is skipped and never checked out over', async () => {
  await standingRepo(({ repo, runsDir, sha, next }) => {
    writeFileSync(join(repo.dir, 'precious.txt'), 'mine');
    writeFileSync(join(repo.dir, 'tracked.txt'), 'edited\n');
    mkdirSync(standingDir(runsDir, 'demo', 0), { recursive: true });
    symlinkSync(repo.dir, standingPath(runsDir, 'demo', 0));
    const elsewhere = tempDir();
    mkdirSync(join(runsDir, STANDING_DIR), { recursive: true });
    symlinkSync(elsewhere, standingDir(runsDir, 'demo', 1));
    const got = leaseStanding({ repo: repo.dir, run: next('run-a'), sha, env: repo.env });
    expect(got).toBeUndefined();
    expect(read(repo.dir, 'precious.txt')).toBe('mine');
    expect(read(repo.dir, 'tracked.txt')).toBe('edited\n');
    expect(existsSync(join(standingDir(runsDir, 'demo', 0), 'LEASE'))).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

test('a link at standing/ is never looked into', async () => {
  await standingRepo(({ repo, runsDir, sha, next }) => {
    const elsewhere = tempDir();
    symlinkSync(elsewhere, join(runsDir, STANDING_DIR));
    expect(leaseStanding({ repo: repo.dir, run: next('run-a'), sha, env: repo.env })).toBeUndefined();
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

test('a standing directory whose LEASE cannot be read is skipped, and the walk goes on to the next', async () => {
  await standingRepo(({ repo, runsDir, sha, next }) => {
    mkdirSync(standingDir(runsDir, 'demo', 0), { recursive: true });
    writeFileSync(join(standingDir(runsDir, 'demo', 0), 'LEASE'), 'garbage');
    const got = leaseStanding({ repo: repo.dir, run: next('run-a'), sha, env: repo.env });
    expect(got?.path).toBe(standingPath(runsDir, 'demo', 1));
    expect(read(standingDir(runsDir, 'demo', 0), 'LEASE')).toBe('garbage');
  });
});

test('a standing worktree removed by hand is made again', async () => {
  await standingRepo(({ repo, runsDir, sha, next }) => {
    const path = leaseStanding({ repo: repo.dir, run: next('run-a'), sha, env: repo.env })?.path ?? '';
    rmSync(path, { recursive: true, force: true });
    releaseStanding(repo.dir, next('run-a', 'completed'), path, repo.env);
    const again = leaseStanding({ repo: repo.dir, run: next('run-b'), sha, env: repo.env });
    expect(again?.path).toBe(standingPath(runsDir, 'demo', 0));
    expect(read(path, 'tracked.txt')).toBe('committed\n');
  });
});

test('releaseStanding by a run that no longer holds the lease writes no ref and leaves the lease', async () => {
  await standingRepo(({ repo, runsDir, sha, next }) => {
    const old = next('run-a');
    const path = leaseStanding({ repo: repo.dir, run: old, sha, env: repo.env })?.path ?? '';
    writeFileSync(join(old.runDir, 'run.json'), JSON.stringify({ repository: { baseSha: sha } }));
    writeStatus(old.runDir, 'completed');
    const newer = next('run-b');
    leaseStanding({ repo: repo.dir, run: newer, sha, env: repo.env });
    writeFileSync(join(path, 'tracked.txt'), 'b\n');
    gitSync(path, ['commit', '-qam', 'b'], repo.env);

    const released = releaseStanding(repo.dir, old, path, repo.env);
    expect(released).toEqual({ raw: null });
    expect(gitSync(repo.dir, ['rev-parse', '--verify', '--quiet', 'refs/sail/runs/run-a'], repo.env).code).not.toBe(0);
    expect(readStanding(standingDir(runsDir, 'demo', 0))?.runId).toBe('run-b');
  });
});

test('releaseStanding keeps a head past the base at the run ref and frees the lease, leaving the worktree', async () => {
  await standingRepo(({ repo, runsDir, sha, next }) => {
    const run = next('run-a');
    const path = leaseStanding({ repo: repo.dir, run, sha, env: repo.env })?.path ?? '';
    writeFileSync(join(run.runDir, 'run.json'), JSON.stringify({ repository: { baseSha: sha } }));
    writeFileSync(join(path, 'tracked.txt'), 'x\n');
    gitSync(path, ['commit', '-qam', 'x'], repo.env);
    const head = gitSync(path, ['rev-parse', 'HEAD'], repo.env).stdout.trim();
    const released = releaseStanding(repo.dir, run, path, repo.env);
    expect(released.ref).toBe('refs/sail/runs/run-a');
    expect(released.head).toBe(head);
    expect(repo.git('rev-parse', 'refs/sail/runs/run-a')).toBe(head);
    expect(readStanding(standingDir(runsDir, 'demo', 0))).toBeUndefined();
    expect(existsSync(path)).toBe(true);
  });
});

test('reopenStanding renews the run own lease and gives its worktree with its uncommitted file, and is invalid when another run holds it', async () => {
  await standingRepo(({ repo, runsDir, sha, next }) => {
    const run = next('run-a', 'suspended');
    const path = leaseStanding({ repo: repo.dir, run, sha, env: repo.env })?.path ?? '';
    writeFileSync(join(path, 'wip.txt'), 'wip');
    const from = { branch: 'sail/x', baseSha: sha };
    const workspace = reopenStanding(run, path, from, repo.env);
    expect(workspace.path).toBe(path);
    expect(existsSync(join(path, 'wip.txt'))).toBe(true);

    const intruder = next('run-b', 'running');
    expect(() => reopenStanding(intruder, path, from, repo.env)).toThrow('held by run run-a');
    expect(readStanding(standingDir(runsDir, 'demo', 0))?.runId).toBe('run-a');
  });
});
