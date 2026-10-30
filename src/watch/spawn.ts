// Spawning a dispatched run, `sail <ticket> --workflow <name> --dispatch <run id> [--force]` or, for a pull request,
// `sail '#<n>' --workflow <name> --dispatch <run id> --head-sha <sha>`, and a resume of one,
// `sail resume <run id>`, each as a process of its own.
//
// - The child is detached: a session and a process group of its own, stdin ignored and unreferenced, so a run outlives
//   its watcher (ADR-0018), and neither a Ctrl-C at the watcher's terminal nor the watcher's exit reaches it.
// - Its stdout and stderr go to `.sail-runs/queue/<workflow>/dispatch/<run id>.log`, not to the run directory: the
//   child makes that itself, and a start refuses one that exists. A start refused before its run directory exists
//   leaves only this log, whose last line says why. A resume appends to its run's log from the offset it reports as
//   `logFrom`, so only what follows that offset is the resume's, and the log's last line after it is why the resume
//   failed when it did.
// - `spawnDetached()` is the start itself: the dashboard's server starts a resume or a seeded run through it, so a run it
//   starts is detached as a watched one is.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { queueDir } from './queue-store';

/** The `sail` the watcher starts: this checkout's bin, on the Bun the watcher runs on. */
const SAIL_CLI = [process.execPath, join(import.meta.dir, '..', 'cli', 'main.ts')];

/** Where the output of the dispatched run `runId` of `workflow` goes. */
export function dispatchLog(runsDir: string, workflow: string, runId: string): string {
  return join(queueDir(runsDir, workflow), 'dispatch', `${runId}.log`);
}

export interface SpawnRunOptions {
  /** The directory that holds `.sail/`: the child's cwd. */
  root: string;
  runsDir: string;
  workflow: string;
  /** The ticket the run starts from. A pull-request run names `pr` instead. */
  ticketKey?: string;
  /** The pull request the run starts from, pinned to the head sha it was queued at. */
  pr?: { number: number; headSha: string };
  runId: string;
  /** The child's whole environment. */
  env: Readonly<Record<string, string>>;
  /** The command the arguments follow: this checkout's `sail` when left out. */
  cli?: readonly string[];
  /** Starts the run with `--force`: a forced queue item. */
  force?: boolean;
}

export interface SpawnResumeOptions {
  /** The directory that holds `.sail/`: the child's cwd. */
  root: string;
  runsDir: string;
  workflow: string;
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
  /** The byte length of the dispatch log when the child started: its own output begins there. */
  logFrom: number;
}

/** Starts `sail <args>` in `root`, detached, its output appended to `log`. The dashboard's server starts its runs here too. */
export function spawnDetached(
  root: string,
  log: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cli: readonly string[] | undefined,
): SpawnedRun {
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'a');
  try {
    const logFrom = fstatSync(fd).size;
    const child = Bun.spawn([...(cli ?? SAIL_CLI), ...args], {
      cwd: root,
      env: { ...env },
      detached: true,
      stdin: 'ignore',
      stdout: fd,
      stderr: fd,
    });
    child.unref();
    return { pid: child.pid, exited: child.exited.then(() => child.exitCode), logFrom };
  } finally {
    // The child holds its own copy of the descriptor.
    closeSync(fd);
  }
}

/** Starts the dispatched run, detached, its output appended to its dispatch log. */
export function spawnRun(options: SpawnRunOptions): SpawnedRun {
  const { root, runsDir, workflow, ticketKey, pr, runId, env } = options;
  const ref = pr === undefined ? (ticketKey ?? '') : `#${pr.number}`;
  const pinned = pr === undefined ? [] : ['--head-sha', pr.headSha];
  const args = [
    ref,
    '--workflow',
    workflow,
    '--dispatch',
    runId,
    ...pinned,
    ...(options.force === true ? ['--force'] : []),
  ];
  return spawnDetached(root, dispatchLog(runsDir, workflow, runId), args, env, options.cli);
}

/** Starts `sail resume <run>`, detached, its output appended to the run's dispatch log. */
export function spawnResume(options: SpawnResumeOptions): SpawnedRun {
  const { root, runsDir, workflow, runId, env } = options;
  return spawnDetached(root, dispatchLog(runsDir, workflow, runId), ['resume', runId], env, options.cli);
}

/** The longest reason a log's last line gives. */
const LINE_MAX = 500;

/** The last line of the log at `path`, after byte `from`, that isn't blank, cut to 500 characters, or undefined when there is none. */
export function lastLine(path: string, from = 0): string | undefined {
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path)
    .subarray(from)
    .toString('utf8')
    .split('\n')
    .map((each) => each.trim())
    .findLast((each) => each !== '');
  return line?.slice(0, LINE_MAX);
}
