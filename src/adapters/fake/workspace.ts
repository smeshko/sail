// The fake Workspace port: detached worktrees of a local git repository standing in for the remote, one per run at
// `<runDir>/workspace` (D12), kept apart by the shared branch leases (D9). It runs on the same plumbing as
// `git-worktree` (src/adapters/workspace/git.ts) and differs from it in three things: it fetches nothing, its remote is
// a constant (`fake://origin` unless set), and its definition keeps leases beside the repository's runs rather than
// machine-wide. The branch is never checked out: a workspace records it for the later push of `HEAD:<branch>`, so only
// the lease keeps two runs of one branch apart (ADR-0018). `holder()` reads the same leases.
import { basename, join } from 'node:path';
import type { ProviderEvent } from '../../events/types';
import { PortError } from '../../ports/errors';
import type { ProviderOptions } from '../../ports/ticket-source';
import type { WorkspacePort } from '../../ports/workspace';
import { defaultLeasesDir, heldLease, releaseLease, takeLease } from '../leases';
import {
  addDetached,
  diffWorkingTree,
  releaseWorktree,
  reopenWorktree,
  resolveCommit,
  sweepEnded,
  WORKSPACE_DIR,
} from '../workspace/git';

/** The remote the fake reports when none is set. */
export const FAKE_REMOTE = 'fake://origin';

export interface FakeWorkspaceOptions extends ProviderOptions {
  /** The local git repository that stands in for the remote. */
  readonly repo: string;
  /** The remote `repository()` reports, which keys the leases. `fake://origin` when left out. */
  readonly remote?: string;
  /** The branch a workspace starts from when `create()` is given no base. `main` when left out. */
  readonly defaultBranch?: string;
  /** Where leases live. `defaultLeasesDir(env)` when left out. */
  readonly leasesDir?: string;
  /** The environment for the git the fake runs. */
  readonly env?: Readonly<Record<string, string>>;
}

export function createFakeWorkspace(options: FakeWorkspaceOptions): WorkspacePort {
  const now = () => options.now?.() ?? new Date();
  const emit = (event: ProviderEvent) => options.emit?.(event);
  const leasesDir = () => options.leasesDir ?? defaultLeasesDir(options.env ?? process.env);
  const { repo, env } = options;
  const defaultBranch = options.defaultBranch ?? 'main';

  return {
    name: 'fake',
    async repository() {
      return { url: options.remote ?? FAKE_REMOTE, defaultBranch, raw: null };
    },
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
    async holder(remote, branch) {
      return heldLease(leasesDir(), remote, branch);
    },
    async create(run, { base = defaultBranch, branch }) {
      const started = now().getTime();
      const baseSha = resolveCommit(repo, base, env);
      if (baseSha === undefined) throw new PortError('workspace', 'create', 'invalid', `${base} names no commit`);
      const path = join(run.runDir, WORKSPACE_DIR);
      const added = addDetached(repo, path, baseSha, env);
      emit({ type: 'workspace:created', path, branch, baseSha, durationMs: Math.max(0, now().getTime() - started) });
      return { path, branch, baseSha, raw: added };
    },
    async reopen(run, { branch, baseSha }) {
      return reopenWorktree(join(run.runDir, WORKSPACE_DIR), branch, baseSha, env);
    },
    async diff(path, range) {
      return diffWorkingTree(path, range, env);
    },
    async release(run, keep) {
      const path = join(run.runDir, WORKSPACE_DIR);
      if (keep) {
        emit({ type: 'workspace:released', path, kept: keep });
        return { path, kept: keep, raw: null };
      }
      const { raw, ...commits } = releaseWorktree(repo, run, 'release', env);
      emit({ type: 'workspace:released', path, kept: keep, ...commits });
      return { path, kept: keep, ...commits, raw };
    },
    async sweep(runsDir) {
      const paths = sweepEnded(runsDir, (runDir) =>
        releaseWorktree(repo, { runId: basename(runDir), runDir }, 'sweep', env),
      );
      return { paths, raw: null };
    },
    capabilities: () => ({ keep: true, sweep: true }),
  };
}
