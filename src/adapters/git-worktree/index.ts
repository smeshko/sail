// The git-worktree Workspace adapter: one detached worktree per run, built from `origin/HEAD` of the clone, with branch
// leases kept machine-wide on origin's remote key (ADR-0018). STUB (tdd-plan): final signatures and wrong return values,
// so the tests written against it fail on their assertions until the tasks of ADW-93 fill them in.
import type { Lease, LeaseResult, Released, Swept, Workspace, WorkspaceCapabilities } from '../../ports/types';
import type { ProviderOptions } from '../../ports/ticket-source';
import type { WorkspacePort } from '../../ports/workspace';

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

export function createGitWorktreeWorkspace(options: GitWorktreeOptions): WorkspacePort {
  void options;
  return {
    name: 'git-worktree',
    async lease(): Promise<LeaseResult> {
      return { leased: false, holder: HOLDER, raw: null };
    },
    async releaseLease(): Promise<Released> {
      return { released: false, raw: null };
    },
    async create(): Promise<Workspace> {
      return { path: '', branch: '', baseSha: '', raw: null };
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
      return { keep: false, sweep: false };
    },
  };
}
