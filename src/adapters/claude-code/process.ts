// STUB (harness-guardrails TASK-006): the final types, and a spawner that starts the process in sail's own group and
// reaps nothing.
import { spawn as spawnChild } from 'node:child_process';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

/** How long the leader has to exit by itself once its session ends: beyond the SDK's own ~2 s grace. */
export const REAP_WAIT_MS = 3_000;

export interface Spawner {
  /** The session's `spawnClaudeCodeProcess`. */
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Waits up to `waitMs` for the leader to exit, then stops what is left of its group. Nothing, when none spawned. */
  reap(waitMs?: number): Promise<void>;
}

export function createSpawner(): Spawner {
  return {
    spawn: (options) =>
      spawnChild(options.command, options.args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env,
        stdio: ['pipe', 'pipe', 'ignore'],
      }) as SpawnedProcess,
    reap: async () => undefined,
  };
}
