// The Claude Code process, spawned by sail rather than the SDK (D7): detached, so it leads a process group of its own,
// and everything it starts can be stopped at once through the group id. Ctrl-C reaches sail alone, which ends the
// session in order. When the session ends, however it ends, reap() gives the leader a bounded time to exit, then stops
// whatever is left of the group; the harness returns only after it has.
//
// The CLI starts each Bash command's shell detached too, in a group of its own the leader's never holds. So while the
// leader runs, the spawner looks up its descendants every `trackMs`, once more when the request aborts, and once more
// before an abort's stop, and stops every group it saw one in along with the leader's. A shell that starts and ends between two looks, leaving a job
// behind, goes unseen: the gate refuses a command that sends one to the background.
//
// Every group is also registered with the engine, so sail's exit waits for its stop.
//
// stderr is ignored (D17): the SDK speaks stream-json over stdin and stdout, and reads nothing else.
// POSIX process groups only. A descendant that calls `setsid` leaves the group, and survives unless a look saw it.
import { type ChildProcess, spawn as spawnChild } from 'node:child_process';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_GRACE_MS, descendantGroups, stopGroup, trackGroup, untrackGroup } from '../../engine/process';

/** How long the leader has to exit by itself once its session ends: beyond the SDK's own ~2 s grace. */
export const REAP_WAIT_MS = 3_000;

/** How often the leader's descendants are looked up while it runs. */
export const TRACK_MS = 1_000;

export interface SpawnerOptions {
  /** Milliseconds between two looks at the leader's descendants: TRACK_MS when left out. */
  readonly trackMs?: number;
  /**
   * The request's signal. Its abort looks up the leader's descendants at once, so `stopLiveGroups` reaches their groups
   * while the session is still given time to end in order, before the SDK's own abort.
   */
  readonly signal?: AbortSignal;
}

export interface Spawner {
  /** The session's `spawnClaudeCodeProcess`. */
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Waits up to `waitMs` for the leader to exit, then stops what is left of its groups. Nothing, when none spawned. */
  reap(waitMs?: number): Promise<void>;
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
    if (!alive()) return;
    for (const pgid of descendantGroups(pid)) {
      groups.add(pgid);
      trackGroup(pgid);
    }
  };
  const stopAll = (pid: number) =>
    Promise.all([pid, ...groups].map((pgid) => stopGroup(pgid, DEFAULT_GRACE_MS).then(() => untrackGroup(pgid))));
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
        trackGroup(pid);
        tracker = setInterval(() => look(pid), options.trackMs ?? TRACK_MS);
        tracker.unref();
        const lookNow = () => look(pid);
        options.signal?.addEventListener('abort', lookNow, { once: true });
        spawned.once('exit', () => {
          clearInterval(tracker);
          options.signal?.removeEventListener('abort', lookNow);
        });
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
