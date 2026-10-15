// The Claude Code process, spawned by sail rather than the SDK (D7): detached, so it leads a process group of its own,
// and everything it starts can be stopped at once through the group id. Ctrl-C reaches sail alone, which ends the
// session in order. When the session ends, however it ends, reap() gives the leader a bounded time to exit, then stops
// whatever is left of the group; the harness returns only after it has.
//
// The CLI starts each Bash command's shell detached too, in a group of its own the leader's never holds. So while the
// leader runs, the spawner looks up its descendants every `trackMs`, and once more before an abort's stop, and stops
// every group it saw one in along with the leader's. A shell that starts and ends between two looks, leaving a job
// behind, goes unseen: the gate refuses a command that sends one to the background.
//
// stderr is ignored (D17): the SDK speaks stream-json over stdin and stdout, and reads nothing else.
// POSIX process groups only. A descendant that calls `setsid` leaves the group, and survives unless a look saw it.
import { type ChildProcess, spawn as spawnChild } from 'node:child_process';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_GRACE_MS, stopGroup } from '../../engine/process';

/** How long the leader has to exit by itself once its session ends: beyond the SDK's own ~2 s grace. */
export const REAP_WAIT_MS = 3_000;

/** How often the leader's descendants are looked up while it runs. */
export const TRACK_MS = 1_000;

export interface SpawnerOptions {
  /** Milliseconds between two looks at the leader's descendants: TRACK_MS when left out. */
  readonly trackMs?: number;
}

export interface Spawner {
  /** The session's `spawnClaudeCodeProcess`. */
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Waits up to `waitMs` for the leader to exit, then stops what is left of its groups. Nothing, when none spawned. */
  reap(waitMs?: number): Promise<void>;
}

/** Stops the group, tolerating one that is gone or going: an EPERM mid-stop still ends in a SIGKILL. */
async function stopQuietly(pgid: number): Promise<void> {
  try {
    await stopGroup(pgid, DEFAULT_GRACE_MS);
  } catch {
    // EPERM from a group whose members are exiting: whatever ignored the SIGTERM is killed all the same.
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Gone.
    }
  }
}

/** Every process's pid, parent and group, from `ps`; none when it can't be run. */
function processTable(): { pid: number; ppid: number; pgid: number }[] {
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
function descendantGroups(leader: number): number[] {
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

/** Resolves when `child` has exited, or after `ms`. */
function exited(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
}

export function createSpawner(options: SpawnerOptions = {}): Spawner {
  let child: ChildProcess | undefined;
  let tracker: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<unknown> | undefined;
  /** The groups the leader's descendants were seen in. */
  const groups = new Set<number>();
  const alive = () => child !== undefined && child.exitCode === null && child.signalCode === null;
  const look = (pid: number) => {
    if (alive()) for (const pgid of descendantGroups(pid)) groups.add(pgid);
  };
  const stopAll = (pid: number) => Promise.all([pid, ...groups].map(stopQuietly));
  const stop = (pid: number) => {
    look(pid);
    stopping ??= stopAll(pid);
    return stopping;
  };

  return {
    spawn(spawnOptions) {
      const spawned = spawnChild(spawnOptions.command, spawnOptions.args, {
        ...(spawnOptions.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
        env: spawnOptions.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: true,
      });
      child = spawned;
      const { pid } = spawned;
      if (pid !== undefined) {
        tracker = setInterval(() => look(pid), options.trackMs ?? TRACK_MS);
        tracker.unref();
        spawned.once('exit', () => clearInterval(tracker));
        if (spawnOptions.signal.aborted) void stop(pid);
        else spawnOptions.signal.addEventListener('abort', () => void stop(pid), { once: true });
      }
      return spawned as SpawnedProcess;
    },
    async reap(waitMs = REAP_WAIT_MS) {
      const pid = child?.pid;
      if (child === undefined || pid === undefined) return;
      look(pid);
      await exited(child, waitMs);
      clearInterval(tracker);
      await stopping;
      await stopAll(pid);
    },
  };
}
