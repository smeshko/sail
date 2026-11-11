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
// Every live group is also kept in a process-wide set, so `stopLiveGroups` can end what a call left before sail exits.
// A harness adapter registers the groups it spawns there too, with `trackGroup`.
//
// A stop also ends the groups the leader's descendants are in at that moment, looked up once before the signal. A
// descendant whose parent chain to the leader is already broken (a double fork), or one left in another group by a
// script that exited by itself, survives.
//
// POSIX process groups only. A descendant that calls `setsid` leaves the group, and survives unless that look saw it.
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

/** Every group a `runProcess` or a harness adapter started that hasn't been stopped or found empty. */
const live = new Set<number>();

/** Registers a group a harness spawned, so `stopLiveGroups` ends it before sail exits. */
export function trackGroup(pgid: number): void {
  live.add(pgid);
}

/** Forgets a group once it is stopped or known empty. */
export function untrackGroup(pgid: number): void {
  live.delete(pgid);
}

/** The groups registered now, for a test to see what is left. */
export function liveGroups(): number[] {
  return [...live];
}

/** Sends `signal` to the group: `gone` when nothing is left, `unknown` when macOS answers EPERM for a group that still holds an exiting member, so only SIGKILL settles it. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): 'gone' | 'sent' | 'unknown' {
  try {
    process.kill(-pgid, signal);
    return 'sent';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'gone';
    if (code === 'EPERM') return 'unknown';
    throw error;
  }
}

/** SIGTERM to the group, a wait of up to `graceMs` for it to empty, then SIGKILL to whatever is left. */
export async function stopGroup(pgid: number, graceMs: number): Promise<void> {
  if (signalGroup(pgid, 'SIGTERM') === 'gone') return;
  const deadline = performance.now() + graceMs;
  while (performance.now() < deadline) {
    await Bun.sleep(POLL_MS);
    if (signalGroup(pgid, 0) === 'gone') return;
  }
  signalGroup(pgid, 'SIGKILL');
}

/**
 * Stops every group still registered, so none outlives the sail process: those registered while it waits too, as a
 * harness that looks up its groups on a timer may.
 */
export async function stopLiveGroups(graceMs: number = DEFAULT_GRACE_MS): Promise<void> {
  const stopped = new Set<number>();
  for (let fresh = [...live]; fresh.length > 0; fresh = [...live].filter((pgid) => !stopped.has(pgid))) {
    for (const pgid of fresh) stopped.add(pgid);
    await Promise.all(fresh.map((pgid) => stopGroup(pgid, graceMs)));
  }
}

/** Every process's pid, parent and group, from `ps`; none when it can't be run. */
export function processTable(): { pid: number; ppid: number; pgid: number }[] {
  try {
    const listed = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=,pgid='], { stdout: 'pipe', stderr: 'ignore' });
    return listed.stdout
      .toString()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row) => row.length === 3 && row.every((n) => Number.isInteger(n) && n > 0))
      .map(([pid, ppid, pgid]) => ({ pid: pid as number, ppid: ppid as number, pgid: pgid as number }));
  } catch {
    return [];
  }
}

/** The groups `leader`'s descendants are in, other than its own and sail's. */
export function descendantGroups(leader: number): number[] {
  const table = processTable();
  const own = table.find((row) => row.pid === process.pid)?.pgid;
  const found = new Set<number>();
  const below = [leader];
  for (let at = below.shift(); at !== undefined; at = below.shift()) {
    for (const row of table) {
      if (row.ppid !== at || below.includes(row.pid)) continue;
      below.push(row.pid);
      if (row.pgid !== leader && row.pgid !== own && row.pgid > 1) found.add(row.pgid);
    }
  }
  return [...found];
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
  trackGroup(pgid);
  let timedOut = false;
  let aborted = false;
  let stopping: Promise<unknown> | undefined;
  /** The groups the leader's descendants were in when it was stopped. */
  const found = new Set<number>();
  const stop = () => {
    if (stopping !== undefined) return;
    // One look, before the signal, while the parent chain is whole.
    for (const group of descendantGroups(pgid)) {
      found.add(group);
      trackGroup(group);
    }
    stopping = Promise.all([pgid, ...found].map((group) => stopGroup(group, graceMs)));
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
  try {
    await stopping;
    await stopGroup(pgid, graceMs); // whatever the leader left running
  } finally {
    untrackGroup(pgid);
    for (const group of found) untrackGroup(group);
  }
  return { started: true, code: child.exitCode, signal: child.signalCode ?? null, timedOut, aborted };
}

/** Whether `pid` names a live process: one this process may not signal is alive all the same. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
