// The fake Workspace port: detached worktrees of a local git repository standing in for the remote, one per run at
// `<runDir>/workspace` (D12), kept apart by the shared branch leases (D9). It differs from `git-worktree` only in
// fetching nothing. The branch is never checked out: a workspace records it for the later push of `HEAD:<branch>`, so
// only the lease keeps two runs of one branch apart (ADR-0018).
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readStatus } from '../../engine/run-dir';
import type { ProviderEvent } from '../../events/types';
import { PortError } from '../../ports/errors';
import type { ProviderOptions } from '../../ports/ticket-source';
import type { WorkspacePort } from '../../ports/workspace';
import { defaultLeasesDir, releaseLease, takeLease } from '../leases';

export interface FakeWorkspaceOptions extends ProviderOptions {
  /** The local git repository that stands in for the remote. */
  readonly repo: string;
  /** Where leases live. `defaultLeasesDir()` when left out. */
  readonly leasesDir?: string;
  /** The environment for the git the fake runs. */
  readonly env?: Readonly<Record<string, string>>;
}

interface GitResult {
  readonly code: number;
  /** As git wrote it: a patch's trailing newline and whitespace are part of it. */
  readonly stdout: string;
  readonly stderr: string;
}

/** Whether the run in `runDir` has ended, so its workspace can go. A run with no STATUS hasn't. */
function ended(runDir: string): boolean {
  try {
    const { status } = readStatus(runDir);
    return status === 'completed' || status === 'failed';
  } catch {
    return false;
  }
}

export function createFakeWorkspace(options: FakeWorkspaceOptions): WorkspacePort {
  const now = () => options.now?.() ?? new Date();
  const emit = (event: ProviderEvent) => options.emit?.(event);
  const leasesDir = () => options.leasesDir ?? defaultLeasesDir();
  const git = (cwd: string, ...args: string[]): GitResult => {
    try {
      const result = Bun.spawnSync(['git', ...args], { cwd, ...(options.env ? { env: { ...options.env } } : {}) });
      return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString().trim(),
      };
    } catch (error) {
      // No such directory to run in.
      return { code: -1, stdout: '', stderr: (error as Error).message };
    }
  };
  // git runs in the repository, but a caller's paths are its own, relative to where it runs: git is handed them resolved.
  /** Removes the worktree at `path` from the repository, and fails only when it is still there. */
  const remove = (op: string, path: string): GitResult => {
    const removed = git(options.repo, 'worktree', 'remove', '--force', resolve(path));
    git(options.repo, 'worktree', 'prune');
    if (removed.code !== 0 && existsSync(path)) throw new PortError('workspace', op, 'unavailable', removed.stderr);
    return removed;
  };

  return {
    name: 'fake',
    async lease(remote, branch, holder) {
      const result = takeLease(leasesDir(), remote, branch, holder, now());
      if (result.leased) {
        emit({ type: 'workspace:leased', remote, branch, ...(result.took === undefined ? {} : { took: result.took }) });
      }
      return result;
    },
    async releaseLease(remote, branch, runId) {
      const result = releaseLease(leasesDir(), remote, branch, runId);
      if (result.released) emit({ type: 'workspace:lease_released', remote, branch });
      return result;
    },
    async create(run, { base, branch }) {
      const started = now().getTime();
      const resolved = git(options.repo, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`);
      if (resolved.code !== 0) throw new PortError('workspace', 'create', 'invalid', `${base} names no commit`);
      const baseSha = resolved.stdout.trim();
      const path = join(run.runDir, 'workspace');
      const added = git(options.repo, 'worktree', 'add', '--detach', resolve(path), baseSha);
      if (added.code !== 0) throw new PortError('workspace', 'create', 'unavailable', added.stderr);
      emit({ type: 'workspace:created', path, branch, baseSha, durationMs: Math.max(0, now().getTime() - started) });
      return { path, branch, baseSha, raw: added };
    },
    async diff(path, from) {
      const resolved = git(path, 'rev-parse', '--verify', '--quiet', `${from}^{commit}`);
      if (resolved.code !== 0) {
        throw new PortError('workspace', 'diff', 'invalid', `${path}: ${from} names no commit ${resolved.stderr}`);
      }
      const tracked = git(path, 'diff', '--binary', resolved.stdout.trim(), '--');
      if (tracked.code !== 0) throw new PortError('workspace', 'diff', 'unavailable', `${path}: ${tracked.stderr}`);
      // A file the run created is part of the working tree too. Each new file that isn't ignored is diffed against
      // nothing, which leaves the index alone; `--no-index` exits 1 when the two differ, as a new file always does.
      const listed = git(path, 'ls-files', '--others', '--exclude-standard', '-z');
      const created = listed.stdout
        .split('\0')
        .filter((file) => file !== '')
        .map((file) => git(path, 'diff', '--no-index', '--binary', '--', '/dev/null', file));
      const failed = created.find((result) => result.code !== 1);
      if (listed.code !== 0 || failed !== undefined) {
        throw new PortError('workspace', 'diff', 'unavailable', `${path}: ${(failed ?? listed).stderr}`);
      }
      const patch = tracked.stdout + created.map((result) => result.stdout).join('');
      return { patch, raw: { tracked, created } };
    },
    async release(run, keep) {
      const path = join(run.runDir, 'workspace');
      const raw = keep ? null : remove('release', path);
      emit({ type: 'workspace:released', path, kept: keep });
      return { path, kept: keep, raw };
    },
    async sweep(runsDir) {
      const paths: string[] = [];
      for (const entry of existsSync(runsDir) ? readdirSync(runsDir) : []) {
        const runDir = join(runsDir, entry);
        const path = join(runDir, 'workspace');
        if (!existsSync(path) || !ended(runDir)) continue;
        remove('sweep', path);
        paths.push(path);
      }
      return { paths: paths.sort(), raw: null };
    },
    capabilities: () => ({ keep: true, sweep: true }),
  };
}
