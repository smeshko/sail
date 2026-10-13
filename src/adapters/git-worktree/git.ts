// Runs git for the git-worktree adapter: non-interactively (a credential prompt fails at once, never waits for a
// terminal), through `runProcess`, so a hung fetch is stopped with its process group (ADR-0018).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../engine/process';

/** How long one git call may run before its process group is stopped. */
export const GIT_TIMEOUT_MS = 120_000;

export interface GitResult {
  /** The exit code. -1 when git never started, or was stopped before it exited. */
  readonly code: number;
  /** As git wrote it. */
  readonly stdout: string;
  /** As git wrote it, trimmed. A stop names itself here. */
  readonly stderr: string;
}

/** The environment for a git call: the given one, or the process's, with `GIT_TERMINAL_PROMPT=0` on top. */
function environment(given?: Readonly<Record<string, string>>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(given ?? process.env)) if (value !== undefined) base[key] = value;
  return { ...base, GIT_TERMINAL_PROMPT: '0' };
}

/** Runs `git <args>` in `cwd`. Never prompts: a credential request fails the call. */
export async function git(
  cwd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  const dir = mkdtempSync(join(tmpdir(), 'sail-git-'));
  try {
    const stdout = join(dir, 'stdout');
    const stderr = join(dir, 'stderr');
    const end = await runProcess({
      command: ['git', ...args],
      cwd,
      env: environment(env),
      stdout,
      stderr,
      timeoutMs,
    });
    const out = readFileSync(stdout, 'utf8');
    const err = readFileSync(stderr, 'utf8').trim();
    if (!end.started) return { code: -1, stdout: out, stderr: end.message };
    if (end.timedOut) return { code: -1, stdout: out, stderr: `${err} git ${args[0]} timed out`.trim() };
    return { code: end.code ?? -1, stdout: out, stderr: err };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
