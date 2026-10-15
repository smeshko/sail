// Spawning a dispatched run: `sail <ticket> --workflow <name> --dispatch <run id>` as a process of its own.
//
// - The child is detached: a session and a process group of its own, stdin ignored and unreferenced, so a run outlives
//   its watcher (ADR-0018), and neither a Ctrl-C at the watcher's terminal nor the watcher's exit reaches it.
// - Its stdout and stderr go to `.sail-runs/queue/<workflow>/dispatch/<run id>.log`, not to the run directory: the
//   child makes that itself, and a start refuses one that exists. A start refused before its run directory exists
//   leaves only this log, whose last line says why.
/** Where the output of the dispatched run `runId` of `workflow` goes. */
export function dispatchLog(_runsDir: string, _workflow: string, _runId: string): string {
  return '';
}

export interface SpawnRunOptions {
  /** The directory that holds `.sail/`: the child's cwd. */
  root: string;
  runsDir: string;
  workflow: string;
  ticketKey: string;
  runId: string;
  /** The child's whole environment. */
  env: Readonly<Record<string, string>>;
  /** The command the arguments follow: this checkout's `sail` when left out. */
  cli?: readonly string[];
}

export interface SpawnedRun {
  pid: number;
  /** The child's exit code, or null when a signal ended it. */
  exited: Promise<number | null>;
}

/** Starts the dispatched run, detached, its output appended to its dispatch log. */
export function spawnRun(_options: SpawnRunOptions): SpawnedRun {
  return { pid: 0, exited: Promise.resolve(null) };
}

/** The last line of the log at `path` that isn't blank, cut to 500 characters, or undefined when there is none. */
export function lastLine(_path: string): string | undefined {
  return undefined;
}
