// What one dispatched item's run needs from its watcher. Stub: every item waits.
import type { ResumedFrom } from '../events/types';
import type { WorkspacePort } from '../ports/workspace';
import type { QueueItem } from './queue-store';

export interface ReconcileContext {
  runsDir: string;
  workflow: string;
  isAlive: (pid: number) => boolean;
  /** Where the run's lease is read, before a resume. */
  workspace: Pick<WorkspacePort, 'holder'>;
  /** The dispatcher's first settle: a live run is adopted. */
  first: boolean;
  /** Whether this dispatcher has already resumed the item's run. */
  resumed: boolean;
  /** How the process this dispatcher last started for the item exited, once it has. */
  exited?: number | null;
}

/** What to do with one dispatched item. */
export type Reconciled =
  | { kind: 'in-flight'; adopt: boolean }
  | { kind: 'done' }
  | { kind: 'failed'; reason: string }
  | { kind: 'park'; reason: string }
  | { kind: 'wait' }
  | { kind: 'adopt'; pid: number }
  | { kind: 'resume'; from: ResumedFrom };

export async function reconcileItem(_item: QueueItem, _context: ReconcileContext): Promise<Reconciled> {
  return { kind: 'wait' };
}
