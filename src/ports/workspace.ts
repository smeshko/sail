// The Workspace port: gives a run its workspace and takes it away again, and keeps runs apart with machine-wide branch
// leases (ADR-0018). The port is the Workspace port, and a Workspace is the checkout it returns.
import type {
  Diff,
  LeaseHolder,
  LeaseResult,
  Released,
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
  /** Emits `workspace:leased` when leased, with `took` when a stale lease was taken over. */
  lease(remote: string, branch: string, holder: LeaseHolder): Promise<LeaseResult>;
  /** Emits `workspace:lease_released` when released. */
  releaseLease(remote: string, branch: string, runId: string): Promise<Released>;
  /** A detached checkout of `base`, recording `branch` for the later push. Emits `workspace:created`. */
  create(run: RunRef, from: { readonly base: string; readonly branch: string }): Promise<Workspace>;
  /** The working tree at `path` against `from`. */
  diff(path: string, from: string): Promise<Diff>;
  /** Removes the run's workspace unless `keep`. Emits `workspace:released`. */
  release(run: RunRef, keep: boolean): Promise<WorkspaceReleased>;
  /** Removes the workspaces of the ended runs under `runsDir`. */
  sweep(runsDir: string): Promise<Swept>;
  capabilities(): WorkspaceCapabilities;
}
