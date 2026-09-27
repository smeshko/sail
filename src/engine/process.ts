// Runs one command in its own process group, and makes sure the whole group ends with it.
//
// The leader is spawned detached, so it leads a new process group and everything it starts can be signalled at once
// through the group id. A timeout or an abort stops the group: SIGTERM, then SIGKILL after a grace period. So does the
// leader's own exit, because whatever it leaves running would outlive the call, hold files in `$STAGE_OUT` open, and
// keep writing to its logs after `result.json`.
//
// stdout and stderr go straight to files, never through pipes: a descendant that inherits a pipe keeps it open after
// the leader exits, and a read waiting for it to close would hang until that descendant ends.
//
// POSIX process groups only. A descendant that calls `setsid` leaves the group, and survives the stop.
import { closeSync, openSync } from 'node:fs';

/** How long a stopped group has between SIGTERM and SIGKILL. */
export const DEFAULT_GRACE_MS = 5_000;

const POLL_MS = 50;

export interface ProcessOptions {
  command: string[];
  cwd: string;
  /** The whole environment. Nothing is read from `process.env`: Bun spawns never see a mutated one anyway. */
  env: Record<string, string>;
  /** Where stdout is written, truncated first. */
  stdout: string;
  stderr: string;
  timeoutMs: number;
  graceMs?: number;
  /** Stops the group when it aborts. */
  signal?: AbortSignal;
}

/** How a command ended. `code` and `signal` are the leader's: one of them is null. */
export type ProcessEnd =
  | { started: false; message: string }
  | { started: true; code: number | null; signal: string | null; timedOut: boolean; aborted: boolean };

/** Sends `signal` to the group. False when the group is gone. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** SIGTERM to the group, a wait of up to `graceMs` for it to empty, then SIGKILL to whatever is left. */
export async function stopGroup(pgid: number, graceMs: number): Promise<void> {
  if (!signalGroup(pgid, 'SIGTERM')) return;
  const deadline = performance.now() + graceMs;
  while (performance.now() < deadline) {
    await Bun.sleep(POLL_MS);
    if (!signalGroup(pgid, 0)) return;
  }
  signalGroup(pgid, 'SIGKILL');
}

export async function runProcess(options: ProcessOptions): Promise<ProcessEnd> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const stdout = openSync(options.stdout, 'w');
  let child: Bun.Subprocess;
  try {
    const stderr = openSync(options.stderr, 'w');
    try {
      child = Bun.spawn({
        cmd: options.command,
        cwd: options.cwd,
        env: options.env,
        stdin: 'ignore',
        stdout,
        stderr,
        detached: true,
      });
    } finally {
      closeSync(stderr);
    }
  } catch (error) {
    // A missing command or one without execute permission throws here, and never gets an exit.
    return { started: false, message: (error as Error).message };
  } finally {
    closeSync(stdout);
  }

  const pgid = child.pid;
  let timedOut = false;
  let aborted = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= stopGroup(pgid, graceMs);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const onAbort = () => {
    aborted = true;
    stop();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
  await stopping;
  await stopGroup(pgid, graceMs); // whatever the leader left running
  return { started: true, code: child.exitCode, signal: child.signalCode ?? null, timedOut, aborted };
}
