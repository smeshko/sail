// The git-worktree Workspace adapter: one detached worktree per run, built from `origin/HEAD` of the clone, with branch
// leases kept machine-wide on origin's remote key (ADR-0018). STUB (tdd-plan): final signatures and wrong return values,
// so the tests written against it fail on their assertions until the tasks of ADW-93 fill them in.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ProviderEvent } from '../../events/types';
import { PortError } from '../../ports/errors';
import type { ProviderOptions } from '../../ports/ticket-source';
import type { Lease, LeaseResult, Released, Swept, Workspace, WorkspaceCapabilities } from '../../ports/types';
import type { RunRef, WorkspacePort } from '../../ports/workspace';
import { git } from './git';

export interface GitWorktreeOptions extends ProviderOptions {
  /** The clone the adapter works in. Its `origin` is the remote leases are keyed by. */
  readonly repo: string;
  /** Where leases live. `defaultLeasesDir()` when left out. */
  readonly leasesDir?: string;
  /** The environment for the git the adapter runs. */
  readonly env?: Readonly<Record<string, string>>;
}

const HOLDER: Lease = {
  runId: 'stub',
  runDir: 'stub',
  pid: 1,
  remote: 'stub',
  branch: 'stub',
  takenAt: 'stub',
};

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
  const { repo, env } = options;
  return {
    name: 'git-worktree',
    async lease(): Promise<LeaseResult> {
      return { leased: false, holder: HOLDER, raw: null };
    },
    async releaseLease(): Promise<Released> {
      return { released: false, raw: null };
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
      emit({
        type: 'workspace:created',
        path: relative(resolve(repo), resolve(path)),
        branch: from.branch,
        baseSha,
        durationMs: Math.max(0, Date.now() - started),
      });
      return { path, branch: from.branch, baseSha, raw: { fetched, resolved, added } };
    },
    async diff() {
      return { patch: '', raw: null };
    },
    async release() {
      return { path: '', kept: false, raw: null };
    },
    async sweep(): Promise<Swept> {
      return { paths: [], raw: null };
    },
    async remoteKey() {
      return '';
    },
    async isBasedOn() {
      return false;
    },
    capabilities(): WorkspaceCapabilities {
      return { keep: true, sweep: true };
    },
  };
}
