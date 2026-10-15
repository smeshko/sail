// The watched workflows' queues, as the dashboard reads them: `.sail-runs/queue/<workflow>/queue.json`, which only the
// watcher writes (src/watch/queue-store.ts), beside its queue event stream. Read-only and contained as run files are:
// a workflow directory must have a plain name and lie inside `.sail-runs/` once resolved, and `queue.json` must be a
// regular file inside it, so a symlink can't lead the dashboard out of the clone.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainName } from '../engine/call-dir';
import { runsDir } from '../engine/run-dir';
import { QUEUE_DIR, QUEUE_FILE, QueueFile } from '../watch/queue-store';
import type { RegistryEntry } from '../watch/registry';
import { containedFile, inside } from './contained';

/** One watched workflow's queue: its file when it can be read, or why not. A queue not written yet has neither. */
export interface QueueView {
  workflow: string;
  queue?: QueueFile;
  problem?: string;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The directory of `workflow`'s queue when it is one of the repository's own, else undefined. */
function queueDirOf(entry: RegistryEntry, workflow: string): string | undefined {
  if (!isPlainName(workflow)) return undefined;
  const runs = runsDir(entry.sailDir);
  const dir = join(runs, QUEUE_DIR, workflow);
  try {
    return inside(runs, dir) && statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** `queue.json` of the queue in `dir`, parsed, or why it can't be. */
function readQueue(dir: string): { queue?: QueueFile; problem?: string } {
  const path = join(dir, QUEUE_FILE);
  try {
    lstatSync(path);
  } catch {
    return {};
  }
  const real = containedFile(dir, path);
  if (real === undefined) return { problem: `${QUEUE_FILE} is not a file of this queue, so nothing of it is read` };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(real, 'utf8'));
  } catch (error) {
    return { problem: `${QUEUE_FILE} can't be read: ${messageOf(error)}` };
  }
  const parsed = QueueFile.safeParse(data);
  if (parsed.success) return { queue: parsed.data };
  const issues = parsed.error.issues.map((issue) => `/${issue.path.join('/')} ${issue.message}`);
  return { problem: `${QUEUE_FILE} is not a queue: ${issues.join('; ')}` };
}

/** One view per queue directory of the repository, in name order. A repository whose `.sail/` is gone has none. */
export function queueViews(entry: RegistryEntry): QueueView[] {
  const runs = runsDir(entry.sailDir);
  const root = join(runs, QUEUE_DIR);
  if (!existsSync(entry.sailDir) || !existsSync(root) || !inside(runs, root)) return [];
  return readdirSync(root)
    .sort()
    .flatMap((workflow) => {
      const dir = queueDirOf(entry, workflow);
      return dir === undefined ? [] : [{ workflow, ...readQueue(dir) }];
    });
}

/** The directory of `workflow`'s queue in the repository, or why there is none. */
export function findQueueDir(entry: RegistryEntry, workflow: string): string | { missing: string } {
  return queueDirOf(entry, workflow) ?? { missing: `no queue '${workflow}' in ${entry.name}` };
}
