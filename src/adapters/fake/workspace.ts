// The fake Workspace port: detached worktrees of a local git repository standing in for the remote, one per run at
// `<runDir>/workspace` (D12), kept apart by the shared branch leases (D9). It differs from `git-worktree` only in
// fetching nothing.
// STUB (TASK-008): nothing is leased, created or removed yet.
import type { ProviderOptions } from '../../ports/ticket-source';
import type { WorkspacePort } from '../../ports/workspace';

export interface FakeWorkspaceOptions extends ProviderOptions {
  /** The local git repository that stands in for the remote. */
  readonly repo: string;
  /** Where leases live. `defaultLeasesDir()` when left out. */
  readonly leasesDir?: string;
  /** The environment for the git the fake runs. */
  readonly env?: Readonly<Record<string, string>>;
}

export function createFakeWorkspace(_options: FakeWorkspaceOptions): WorkspacePort {
  return {
    name: 'fake',
    lease: async (remote, branch, holder) => ({
      leased: false,
      holder: { remote, branch, ...holder, takenAt: '' },
      raw: null,
    }),
    releaseLease: async () => ({ released: false, raw: null }),
    create: async (_run, { branch }) => ({ path: '', branch, baseSha: '', raw: null }),
    diff: async () => ({ patch: '', raw: null }),
    release: async (_run, keep) => ({ path: '', kept: !keep, raw: null }),
    sweep: async () => ({ paths: [], raw: null }),
    capabilities: () => ({ keep: false, sweep: false }),
  };
}
