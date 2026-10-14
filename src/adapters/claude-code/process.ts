// The Claude Code process, spawned by sail rather than the SDK (D7): detached, so it leads a process group of its own,
// and everything it starts, the Bash tool's shells included, can be stopped at once through the group id. Ctrl-C reaches
// sail alone, which ends the session in order. When the session ends, however it ends, reap() gives the leader a
// bounded time to exit, then stops whatever is left of the group; the harness returns only after it has.
//
// stderr is ignored (D17): the SDK speaks stream-json over stdin and stdout, and reads nothing else.
// POSIX process groups only. A descendant that calls `setsid` leaves the group, and survives the stop.
import { type ChildProcess, spawn as spawnChild } from 'node:child_process';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_GRACE_MS, stopGroup } from '../../engine/process';

/** How long the leader has to exit by itself once its session ends: beyond the SDK's own ~2 s grace. */
export const REAP_WAIT_MS = 3_000;

export interface Spawner {
  /** The session's `spawnClaudeCodeProcess`. */
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Waits up to `waitMs` for the leader to exit, then stops what is left of its group. Nothing, when none spawned. */
  reap(waitMs?: number): Promise<void>;
}

/** Stops the group, tolerating one that is gone or going. */
async function stopQuietly(pgid: number): Promise<void> {
  try {
    await stopGroup(pgid, DEFAULT_GRACE_MS);
  } catch {
    // EPERM from a group whose members are exiting: they are going anyway.
  }
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

export function createSpawner(): Spawner {
  let child: ChildProcess | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (pgid: number) => {
    stopping ??= stopQuietly(pgid);
    return stopping;
  };

  return {
    spawn(options) {
      const spawned = spawnChild(options.command, options.args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: true,
      });
      child = spawned;
      const { pid } = spawned;
      if (pid !== undefined) {
        if (options.signal.aborted) void stop(pid);
        else options.signal.addEventListener('abort', () => void stop(pid), { once: true });
      }
      return spawned as SpawnedProcess;
    },
    async reap(waitMs = REAP_WAIT_MS) {
      const pid = child?.pid;
      if (child === undefined || pid === undefined) return;
      await exited(child, waitMs);
      await stopping;
      await stopQuietly(pid);
    },
  };
}
