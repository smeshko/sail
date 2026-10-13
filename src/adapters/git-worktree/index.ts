// The git-worktree Workspace adapter: one detached worktree per run, built from `origin/HEAD` of the clone, with branch
// leases kept machine-wide on origin's remote key (ADR-0018).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProviderEvent } from '../../events/types';
import { PortError } from '../../ports/errors';
import type { ProviderOptions } from '../../ports/ticket-source';
import type { Workspace, WorkspaceCapabilities } from '../../ports/types';
import type { RunRef, WorkspacePort } from '../../ports/workspace';
import { leasesDirFor, releaseLease, takeLease } from '../leases';
import { basedOn, clonePath, diffFrom, removeWorktree, sweepRuns } from '../worktree-git';
import { git } from './git';
import { remoteKeyOf } from './remote';

export interface GitWorktreeOptions extends ProviderOptions {
  /** The clone the adapter works in. Its `origin` is the remote leases are keyed by. */
  readonly repo: string;
  /** Where leases live. Under the environment's HOME when left out. */
  readonly leasesDir?: string;
  /** The environment for the git the adapter runs. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Keeps the clone's `.sail-runs/` out of its `git status`, through the clone's own `info/exclude`: a checked-in
 * `.gitignore` is not the clone's to change, and the clone's working tree stays as it was.
 */
async function excludeRunsDir(clone: string, env?: Readonly<Record<string, string>>): Promise<void> {
  const found = await git(clone, ['rev-parse', '--git-path', 'info/exclude'], env);
  if (found.code !== 0) return;
  const file = resolve(clone, found.stdout.trim());
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  if (lines.includes('.sail-runs/')) return;
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, '.sail-runs/\n');
}

export function createGitWorktreeWorkspace(options: GitWorktreeOptions): WorkspacePort {
  const emit = (event: ProviderEvent) => options.emit?.(event);
  const now = () => options.now?.() ?? new Date();
  const leasesDir = () => options.leasesDir ?? leasesDirFor(options.env, options.repo);
  const { repo, env } = options;
  const runGit = (cwd: string, args: readonly string[]) => git(cwd, [...args], env);
  return {
    name: 'git-worktree',
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
    async create(run: RunRef, from: { readonly base: string; readonly branch: string }): Promise<Workspace> {
      const started = Date.now();
      const names = ['rev-parse', '--verify', '--quiet', `${from.base}^{commit}`];
      const unset = () =>
        new PortError(
          'workspace',
          'create',
          'invalid',
          `${from.base} names no commit; set it with git remote set-head origin --auto`,
        );
      // Checked before the fetch too: a fetch recreates a missing origin/HEAD, which would hide that it was unset.
      if ((await git(repo, names, env)).code !== 0) throw unset();
      const fetched = await git(repo, ['fetch', '--quiet', 'origin'], env);
      if (fetched.code !== 0) throw new PortError('workspace', 'create', 'unavailable', fetched.stderr, fetched);
      const resolved = await git(repo, names, env);
      if (resolved.code !== 0) throw unset();
      const baseSha = resolved.stdout.trim();
      const path = join(run.runDir, 'workspace');
      const added = await git(repo, ['worktree', 'add', '--detach', resolve(path), baseSha], env);
      if (added.code !== 0) throw new PortError('workspace', 'create', 'unavailable', added.stderr, added);
      await excludeRunsDir(repo, env);
      const head = await git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], env);
      const defaultBranch = head.code === 0 ? head.stdout.trim().replace(/^origin\//, '') : undefined;
      emit({
        type: 'workspace:created',
        path: clonePath(repo, path),
        branch: from.branch,
        baseSha,
        durationMs: Math.max(0, Date.now() - started),
      });
      return {
        path,
        branch: from.branch,
        baseSha,
        ...(defaultBranch === undefined ? {} : { defaultBranch }),
        raw: { fetched, resolved, added },
      };
    },
    diff: (path, from) => diffFrom(runGit, path, from),
    async release(run, keep) {
      const path = join(run.runDir, 'workspace');
      const raw = keep ? null : await removeWorktree(runGit, repo, 'release', path);
      emit({ type: 'workspace:released', path: clonePath(repo, path), kept: keep });
      return { path, kept: keep, raw };
    },
    async sweep(runsDir) {
      return { paths: await sweepRuns(runGit, repo, runsDir), raw: null };
    },
    remoteKey: (clone) => remoteKeyOf(clone, env),
    isBasedOn: (path, baseSha) => basedOn(runGit, path, baseSha),
    capabilities(): WorkspaceCapabilities {
      return { keep: true, sweep: true };
    },
  };
}
