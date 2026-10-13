// The fake Workspace port: detached worktrees of a local git repository standing in for the remote, one per run at
// `<runDir>/workspace` (D12), kept apart by the shared branch leases (D9). It differs from `git-worktree` only in
// fetching nothing. The branch is never checked out: a workspace records it for the later push of `HEAD:<branch>`, so
// only the lease keeps two runs of one branch apart (ADR-0018).
import { join, resolve } from 'node:path';
import type { ProviderEvent } from '../../events/types';
import { PortError } from '../../ports/errors';
import type { ProviderOptions } from '../../ports/ticket-source';
import type { WorkspacePort } from '../../ports/workspace';
import { leasesDirFor, releaseLease, takeLease } from '../leases';
import { clonePath, diffFrom, type GitResult, removeWorktree, sweepRuns } from '../worktree-git';

export interface FakeWorkspaceOptions extends ProviderOptions {
  /** The local git repository that stands in for the remote. */
  readonly repo: string;
  /** Where leases live. Under the environment's HOME when left out. */
  readonly leasesDir?: string;
  /** The environment for the git the fake runs. */
  readonly env?: Readonly<Record<string, string>>;
}

export function createFakeWorkspace(options: FakeWorkspaceOptions): WorkspacePort {
  const now = () => options.now?.() ?? new Date();
  const emit = (event: ProviderEvent) => options.emit?.(event);
  const leasesDir = () => options.leasesDir ?? leasesDirFor(options.env, options.repo);
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
  const runGit = async (cwd: string, args: readonly string[]) => git(cwd, ...args);

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
      const names = (ref: string) => git(options.repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
      // The engine bases every run on origin/HEAD. A repository with no origin has none, so its HEAD is the base.
      let resolved = names(base);
      if (resolved.code !== 0 && base === 'origin/HEAD') resolved = names('HEAD');
      if (resolved.code !== 0) throw new PortError('workspace', 'create', 'invalid', `${base} names no commit`);
      const baseSha = resolved.stdout.trim();
      const path = join(run.runDir, 'workspace');
      const added = git(options.repo, 'worktree', 'add', '--detach', resolve(path), baseSha);
      if (added.code !== 0) throw new PortError('workspace', 'create', 'unavailable', added.stderr);
      emit({
        type: 'workspace:created',
        path: clonePath(options.repo, path),
        branch,
        baseSha,
        durationMs: Math.max(0, now().getTime() - started),
      });
      return { path, branch, baseSha, raw: added };
    },
    diff: (path, from) => diffFrom(runGit, path, from),
    async release(run, keep) {
      const path = join(run.runDir, 'workspace');
      const raw = keep ? null : await removeWorktree(runGit, options.repo, 'release', path);
      emit({ type: 'workspace:released', path: clonePath(options.repo, path), kept: keep });
      return { path, kept: keep, raw };
    },
    async sweep(runsDir) {
      return { paths: await sweepRuns(runGit, options.repo, runsDir), raw: null };
    },
    // The fake's remote is a path, which no event or run file may hold, so every clone reports the same name.
    async remoteKey() {
      return 'fake';
    },
    async isBasedOn() {
      return false;
    },
    capabilities: () => ({ keep: true, sweep: true }),
  };
}
