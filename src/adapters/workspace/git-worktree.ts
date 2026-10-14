// The built-in `git-worktree` Workspace adapter. Stubs for TASK-002 (ADW-93): the signatures, with wrong values. A
// stub workspace is an empty directory beside where the real one goes, so a test fails on what it finds there.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterDefinition } from '../../ports/adapter';
import type { ProviderOptions } from '../../ports/ticket-source';
import type { WorkspacePort } from '../../ports/workspace';

/** How long a fetch may take before it is killed. */
export const FETCH_TIMEOUT_MS = 120_000;

export interface GitWorktreeOptions extends ProviderOptions {
  readonly repo: string;
  readonly remote?: string;
  readonly defaultBranch?: string;
  readonly leasesDir?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly fetchTimeoutMs?: number;
}

export function createGitWorktreeWorkspace(_options: GitWorktreeOptions): WorkspacePort {
  const none = { path: '', branch: '', baseSha: '', raw: null };
  return {
    name: 'git-worktree',
    repository: async () => ({ url: '', defaultBranch: '', raw: null }),
    lease: async () => ({
      leased: false,
      holder: { remote: '', branch: '', runId: '', runDir: '', pid: 1, takenAt: '' },
      raw: null,
    }),
    releaseLease: async () => ({ released: false, raw: null }),
    create: async (run) => {
      mkdirSync(join(run.runDir, 'stub-workspace'), { recursive: true });
      return { ...none, path: join(run.runDir, 'stub-workspace') };
    },
    reopen: async () => none,
    diff: async () => ({ patch: '', raw: null }),
    release: async (_run, keep) => ({ path: '', kept: keep, raw: null }),
    sweep: async () => ({ paths: [], raw: null }),
    capabilities: () => ({ keep: false, sweep: false }),
  };
}

/** `workspace: { use: git-worktree }`. */
export const gitWorktreeDefinition: AdapterDefinition<WorkspacePort> = {
  create(_options, context) {
    return createGitWorktreeWorkspace({ repo: context.root });
  },
};
