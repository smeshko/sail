// pi's bash tool, run by sail: pi's own operations are replaced by these, so that each command's `/bin/bash` is spawned
// detached and leads a process group of its own, in an environment scrubbed of credentials. An abort or a timeout
// stops the command's group; reap() stops every group still alive, so the harness returns only after none is left.
// POSIX process groups only. A descendant that calls `setsid` leaves the group, and survives the stop; the gate
// refuses a command that sends a job to the background.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DEFAULT_GRACE_MS, stopGroup } from '../../engine/process';
import { ENV_ALLOWLIST } from '../claude-code/harness';

/** How long the output of a command that has exited has to arrive, when a descendant still holds its pipes. */
const FLUSH_MS = 200;

export type BashExec = (
  command: string,
  cwd: string,
  options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ exitCode: number | null }>;

export interface BashRunner {
  /** What pi's bash tool is given in place of its own operations. */
  readonly operations: { exec: BashExec };
  /** Stops every group a command started and is still alive, and waits until none is. */
  reap(): Promise<void>;
}

/** Names the credentials of a provider sit under: allowlisted for the harness itself, never for a command. */
const CREDENTIALS = /^(?:ANTHROPIC_|AWS_|CLAUDE_|CLOUD_ML_|GOOGLE_)|(?:_API_KEY|_TOKEN|_SECRET|_SECRET_KEY)$/;

const allowed = (name: string): boolean =>
  ENV_ALLOWLIST.some((entry) => (entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry));

/** A command's environment: the allowlisted names of `env` that are no credential, the preamble, then the shell. */
export function bashEnv(
  preamble: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const picked = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && allowed(entry[0]) && !CREDENTIALS.test(entry[0]),
  );
  return { ...Object.fromEntries(picked), ...preamble, SHELL: '/bin/bash' };
}

/** Whether any process is left in the group `pgid` leads. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function createBashRunner(options: { env: Readonly<Record<string, string>> }): BashRunner {
  /** The pids of the commands still running, each the leader of its group. */
  const live = new Set<number>();
  const stopping = new Set<Promise<void>>();

  const stop = (pid: number): Promise<void> => {
    const stopped = stopGroup(pid, DEFAULT_GRACE_MS).finally(() => stopping.delete(stopped));
    stopping.add(stopped);
    return stopped;
  };

  const exec: BashExec = (command, cwd, { onData, signal, timeout }) =>
    new Promise((resolve, reject) => {
      if (!existsSync(cwd)) {
        reject(new Error(`Working directory does not exist: ${cwd}`));
        return;
      }
      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const child = spawn('/bin/bash', ['-c', command], {
        cwd,
        env: options.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const { pid } = child;
      if (pid === undefined) {
        child.once('error', reject);
        return;
      }
      live.add(pid);
      let timedOut = false;
      const timer =
        timeout !== undefined && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              void stop(pid);
            }, timeout * 1000)
          : undefined;
      const onAbort = () => void stop(pid);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const finish = (end: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // A group that still holds a descendant stays tracked, for reap() to stop.
        if (!groupAlive(pid)) live.delete(pid);
        end();
      };
      child.once('error', (error) => finish(() => reject(error)));
      child.once('exit', (code) => {
        // A descendant holding the pipes would keep 'close' from coming: the output gets a moment, no more.
        const done = () => {
          clearTimeout(flush);
          finish(() => {
            if (signal?.aborted) reject(new Error('aborted'));
            else if (timedOut) reject(new Error(`timeout:${timeout}`));
            else resolve({ exitCode: code });
          });
        };
        const flush = setTimeout(done, FLUSH_MS);
        child.once('close', done);
      });
    });

  return {
    operations: { exec },
    async reap() {
      for (const pid of live) void stop(pid);
      await Promise.all(stopping);
    },
  };
}
