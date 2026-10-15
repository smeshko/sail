// Spawning a dispatched run: `sail <ticket> --workflow <name> --dispatch <run id>` as a process of its own.
//
// - The child is detached: a session and a process group of its own, stdin ignored and unreferenced, so a run outlives
//   its watcher (ADR-0018), and neither a Ctrl-C at the watcher's terminal nor the watcher's exit reaches it.
// - Its stdout and stderr go to `.sail-runs/queue/<workflow>/dispatch/<run id>.log`, not to the run directory: the
//   child makes that itself, and a start refuses one that exists. A start refused before its run directory exists
//   leaves only this log, whose last line says why.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
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
export function spawnRun(options: SpawnRunOptions): SpawnedRun {
  const { root, runsDir, workflow, ticketKey, runId, env } = options;
  const log = dispatchLog(runsDir, workflow, runId);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'a');
  try {
    const child = Bun.spawn([...(options.cli ?? SAIL_CLI), ticketKey, '--workflow', workflow, '--dispatch', runId], {
      cwd: root,
      env: { ...env },
      detached: true,
      stdin: 'ignore',
      stdout: fd,
      stderr: fd,
    });
    child.unref();
    return { pid: child.pid, exited: child.exited.then(() => child.exitCode) };
  } finally {
    // The child holds its own copy of the descriptor.
    closeSync(fd);
  }
}

/** The longest reason a log's last line gives. */
const LINE_MAX = 500;

/** The last line of the log at `path` that isn't blank, cut to 500 characters, or undefined when there is none. */
export function lastLine(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .map((each) => each.trim())
    .findLast((each) => each !== '');
  return line?.slice(0, LINE_MAX);
}
