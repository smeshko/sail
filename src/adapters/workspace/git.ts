// The git plumbing the built-in Workspace adapters share: `git-worktree`, and the fake, which runs on it with no fetch.
// Stubs for TASK-001 and TASK-002 (ADW-93): the signatures, with wrong values.
import type { Diff, Workspace } from '../../ports/types';

export interface GitResult {
  readonly code: number;
  /** As git wrote it: a patch's trailing newline and whitespace are part of it. */
  readonly stdout: string;
  readonly stderr: string;
}

/** How long a local git call may take. */
export const LOCAL_TIMEOUT_MS = 30_000;

/** The directory a run's workspace takes, inside its run directory. */
export const WORKSPACE_DIR = 'workspace';

/** `env` with every way git could ask for credentials turned off. */
export function nonInteractive(env: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { ...env };
}

/** Runs git in `cwd` with `env`, never reading stdin. */
export function gitSync(
  _cwd: string,
  _args: readonly string[],
  _env?: Readonly<Record<string, string>>,
  _timeoutMs: number = LOCAL_TIMEOUT_MS,
): GitResult {
  return { code: 0, stdout: '', stderr: '' };
}

/** The commit `rev` names in `repo`, or undefined when it names none. */
export function resolveCommit(
  _repo: string,
  _rev: string,
  _env?: Readonly<Record<string, string>>,
): string | undefined {
  return undefined;
}

/** Adds a detached worktree of `sha` at `path`. */
export function addDetached(
  _repo: string,
  _path: string,
  _sha: string,
  _env?: Readonly<Record<string, string>>,
): GitResult {
  return { code: 0, stdout: '', stderr: '' };
}

/** Removes the workspace of the run in `runDir`. */
export function removeWorktree(
  _repo: string,
  _runDir: string,
  _op: string,
  _env?: Readonly<Record<string, string>>,
): GitResult {
  return { code: 0, stdout: '', stderr: '' };
}

/** The working tree at `path` against `range`. */
export function diffWorkingTree(_path: string, _range: string, _env?: Readonly<Record<string, string>>): Diff {
  return { patch: '', raw: null };
}

/** The workspace at `path`, checked to be a worktree whose `HEAD` descends from `baseSha`. */
export function reopenWorktree(
  _path: string,
  _branch: string,
  _baseSha: string,
  _env?: Readonly<Record<string, string>>,
): Workspace {
  return { path: '', branch: '', baseSha: '', raw: null };
}

/** Removes, through `remove`, the workspace of each ended run under `runsDir`, and gives their paths, sorted. */
export function sweepEnded(_runsDir: string, _remove: (runDir: string) => void): string[] {
  return [];
}

/** `url` without its userinfo. */
export function stripUserinfo(url: string): string {
  return url;
}

/** `git fetch --no-tags <remote>` in `repo`, as a process group killed at `timeoutMs` or when `signal` aborts. */
export async function fetchRemote(
  _repo: string,
  _remote: string,
  _env: Readonly<Record<string, string>> | undefined,
  _timeoutMs: number,
  _signal?: AbortSignal,
): Promise<void> {}
