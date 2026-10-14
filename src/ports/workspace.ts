// The Workspace port: gives a run its workspace and takes it away again, and keeps runs apart with machine-wide branch
// leases (ADR-0018). The port is the Workspace port, and a Workspace is the checkout it returns.
import type {
  Diff,
  LeaseHolder,
  LeaseResult,
  Released,
  Repository,
  Swept,
  Workspace,
  WorkspaceCapabilities,
  WorkspaceReleased,
} from './types';

/** The run a workspace belongs to. */
export interface RunRef {
  readonly runId: string;
  readonly runDir: string;
}

export interface WorkspacePort {
  readonly name: string;
  /** The repository's remote, which keys its leases, and the default branch a run starts from. */
  repository(): Promise<Repository>;
  /** Emits `workspace:leased` when leased, with `took` when a stale lease was taken over. */
  lease(remote: string, branch: string, holder: LeaseHolder): Promise<LeaseResult>;
  /** Emits `workspace:lease_released` when released. */
  releaseLease(remote: string, branch: string, runId: string): Promise<Released>;
  /**
   * A detached checkout of `base`, recording `branch` for the later push. Left out, `base` is the default branch's tip
   * on the remote. `signal` stops whatever the adapter fetches first. Emits `workspace:created`.
   */
  create(
    run: RunRef,
    from: { readonly branch: string; readonly base?: string; readonly signal?: AbortSignal },
  ): Promise<Workspace>;
  /**
   * The run's existing workspace, once checked to be a checkout whose `HEAD` descends from `baseSha`. One that is gone,
   * or has lost its base, is `invalid`. Emits nothing.
   */
  reopen(run: RunRef, from: { readonly branch: string; readonly baseSha: string }): Promise<Workspace>;
  /**
   * The working tree at `path` against `range`, as a patch that applies to the commit it is taken against: new files
   * included, ignored ones not. `range` is `<rev>`, against that commit, or `<rev>...` or `<rev>...HEAD`, against the
   * merge-base of `<rev>` and `HEAD`. Any other range, and a rev that names nothing, is `invalid`.
   */
  diff(path: string, range: string): Promise<Diff>;
  /** Removes the run's workspace unless `keep`. Emits `workspace:released`. */
  release(run: RunRef, keep: boolean): Promise<WorkspaceReleased>;
  /** Removes the workspaces of the ended runs under `runsDir`. */
  sweep(runsDir: string): Promise<Swept>;
  capabilities(): WorkspaceCapabilities;
}
