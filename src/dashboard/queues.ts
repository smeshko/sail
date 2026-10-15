// The watched workflows' queues, as the dashboard reads them: `.sail-runs/queue/<workflow>/queue.json`, which only the
// watcher writes (src/watch/queue-store.ts), beside its queue event stream. Read-only and contained as run files are:
// a workflow directory must have a plain name and lie inside `.sail-runs/` once resolved, and `queue.json` must be a
// regular file inside it, so a symlink can't lead the dashboard out of the clone.
//
// Stub (TASK-003): signatures only.
import type { QueueFile } from '../watch/queue-store';
import type { RegistryEntry } from '../watch/registry';

/** One watched workflow's queue: its file when it can be read, or why not. A queue not written yet has neither. */
export interface QueueView {
  workflow: string;
  queue?: QueueFile;
  problem?: string;
}

/** One view per queue directory of the repository, in name order. A repository whose `.sail/` is gone has none. */
export function queueViews(_entry: RegistryEntry): QueueView[] {
  return [];
}

/** The directory of `workflow`'s queue in the repository, or why there is none. */
export function findQueueDir(_entry: RegistryEntry, _workflow: string): string | { missing: string } {
  return { missing: '' };
}
