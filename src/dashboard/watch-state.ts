// A workflow's watch state, said from the live watcher alone: never from the queue's own watch events, which a stopped
// watcher leaves at `watch:added`. The index sends it with every queue view and the server refuses a queue change with
// its `why`, so the reason a page shows and the refusal are one string.
import { liveSet, liveWatcher, type RegistryEntry, type Watched, type WatcherFields } from '../watch/registry';

export type WatchState = 'watched' | 'not watched' | 'watcher not running';

/** What the index sends with a queue view. */
export type QueueWatch = { state: 'watched' } | { state: 'not watched' | 'watcher not running'; why: string };

/** What `workflowWatch` says: for a watched workflow, how the watcher is named and the label it polls on. */
export type WorkflowWatch =
  | { state: 'watched'; named: string; label: string }
  | { state: 'not watched' | 'watcher not running'; why: string };

/** The live watcher of a repository and its watch set in this clone, as `repoWatcher` reads them. */
export type RepoWatcher = { watcher?: WatcherFields; set: Watched[] };

/** The live watcher of the repository and, when it runs in this clone's `.sail/`, its watch set: read once. */
export function repoWatcher(entry: RegistryEntry): RepoWatcher {
  const watcher = liveWatcher(entry);
  if (watcher === undefined) return { set: [] };
  return { watcher, set: watcher.sailDir === entry.sailDir ? liveSet(entry.sailDir, watcher.pid) : [] };
}

/** Whether `workflow` is watched by the repository's live watcher in this clone, and when it isn't, why. */
export function workflowWatch(
  entry: RegistryEntry,
  workflow: string,
  read: RepoWatcher = repoWatcher(entry),
): WorkflowWatch {
  const { watcher, set } = read;
  if (watcher === undefined) {
    return {
      state: 'watcher not running',
      why: `no watcher is running for '${entry.name}': sail watch ${workflow} first`,
    };
  }
  const named = `the watcher of '${entry.name}' (pid ${watcher.pid})`;
  if (watcher.sailDir !== entry.sailDir) {
    return { state: 'watcher not running', why: `${named} runs in another clone: ${watcher.sailDir}` };
  }
  const watched = set.find((each) => each.workflow === workflow);
  if (watched === undefined) {
    return { state: 'not watched', why: `${named} does not watch '${workflow}': sail watch ${workflow} first` };
  }
  return { state: 'watched', named, label: watched.label };
}

/** `watch` as the index sends it. */
export function queueWatch(watch: WorkflowWatch): QueueWatch {
  return watch.state === 'watched' ? { state: 'watched' } : { state: watch.state, why: watch.why };
}
