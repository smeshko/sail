// The git plumbing the built-in Workspace adapters share: `git-worktree`, and the fake, which runs on it with no fetch.
// Every git call gets `nonInteractive()`'s environment, so none can ask for credentials (D7). A local call is a
// synchronous spawn with stdin ignored and a timeout. Only a fetch, the one call that reaches the network, runs as a
// process group under `runProcess()`, with its own timeout and the start's signal.
//
// A workspace is `<runDir>/workspace`: a detached worktree of the repository. git is handed every path resolved, since
// it runs in the repository and a caller's paths are relative to where the caller runs.
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { withoutRepositoryVariables } from '../../engine/git-env';
import { runProcess } from '../../engine/process';
import { readStatus } from '../../engine/run-dir';
import { PortError } from '../../ports/errors';
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

/**
 * `env` with every way git could ask for credentials turned off, and none of the variables that tie git to a
 * repository. git tries an askpass program before it looks at `GIT_TERMINAL_PROMPT`, so an empty `GIT_ASKPASS` turns
 * off `core.askPass` and `SSH_ASKPASS` too, and ssh never uses one. ssh's own prompts need a terminal, which a fetch,
 * in a session of its own, doesn't have: so the user's ssh command (`GIT_SSH_COMMAND`, `GIT_SSH`, `core.sshCommand`)
 * is left as it is.
 */
export function nonInteractive(env: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    ...withoutRepositoryVariables(env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
  };
}

/** This process's environment, without its unset variables: what git runs with when a caller passes none. */
function inherited(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** The subcommand `args` run: the first argument past git's own options and `-c`'s value. */
function subcommand(args: readonly string[]): string {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';
    if (arg === '-c') index++;
    else if (!arg.startsWith('-')) return arg;
  }
  return args[0] ?? '';
}

/**
 * Runs git in `cwd` with `env` (this process's when left out), never reading stdin. A directory that isn't there, or a
 * call that times out, is a failed result.
 */
export function gitSync(
  cwd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
  timeoutMs: number = LOCAL_TIMEOUT_MS,
): GitResult {
  try {
    const result = Bun.spawnSync(['git', ...args], {
      cwd,
      env: nonInteractive(env ?? inherited()),
      stdin: 'ignore',
      timeout: timeoutMs,
    });
    const stderr = result.stderr.toString().trim();
    if (result.exitedDueToTimeout) {
      const said = `git ${subcommand(args)} timed out after ${timeoutMs} ms ${stderr}`.trim();
      return { code: -1, stdout: '', stderr: said };
    }
    return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr };
  } catch (error) {
    // No such directory to run in.
    return { code: -1, stdout: '', stderr: (error as Error).message };
  }
}

/** The commit `rev` names in `repo`, or undefined when it names none. */
export function resolveCommit(repo: string, rev: string, env?: Readonly<Record<string, string>>): string | undefined {
  if (rev.startsWith('-')) return undefined;
  const resolved = gitSync(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], env);
  return resolved.code === 0 ? resolved.stdout.trim() : undefined;
}

/**
 * Adds a detached worktree of `sha` at `path`, with the clone's hooks off: a post-checkout hook (an install, a download)
 * would run under the local timeout, with the terminal, and fail the start. A run's steps prepare their own workspace.
 * A failure is `unavailable`, with git's own words.
 */
export function addDetached(
  repo: string,
  path: string,
  sha: string,
  env?: Readonly<Record<string, string>>,
): GitResult {
  const added = gitSync(
    repo,
    ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', resolve(path), sha],
    env,
  );
  if (added.code !== 0) throw new PortError('workspace', 'create', 'unavailable', added.stderr);
  return added;
}

/** Whether `path` is a symbolic link, dangling or not. */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Removes the workspace of the run in `runDir`: `git worktree remove --force --force`, which takes a locked one too,
 * then, when the path is still there, a plain removal of exactly `<runDir>/workspace` and nothing else, and a prune of
 * what that removal left registered. The prune is the repository's whole, so it runs only then: a worktree of the
 * user's on a volume that isn't mounted stays registered otherwise. A link at the path is unlinked and never followed,
 * since git would remove the worktree it names, and a run directory that is a link is refused for the same reason. It
 * fails, as `unavailable`, when the run directory is a link or the path is still there.
 */
export function removeWorktree(
  repo: string,
  runDir: string,
  op: string,
  env?: Readonly<Record<string, string>>,
): GitResult {
  const path = resolve(runDir, WORKSPACE_DIR);
  if (isLink(runDir)) {
    throw new PortError('workspace', op, 'unavailable', `${runDir} is a link: the run's workspace is left where it is`);
  }
  if (isLink(path)) {
    unlinkSync(path);
    return { code: 0, stdout: '', stderr: '' };
  }
  const removed = gitSync(repo, ['worktree', 'remove', '--force', '--force', path], env);
  let why = removed.stderr;
  if (existsSync(path)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      why = `${why} ${(error as Error).message}`.trim();
    }
    gitSync(repo, ['worktree', 'prune'], env);
  }
  if (existsSync(path)) throw new PortError('workspace', op, 'unavailable', `${path}: ${why}`);
  return removed;
}

/** What `range` diffs against: a rev, and whether it is the merge-base of that rev and `HEAD`. Undefined: no range. */
function parseRange(range: string): { rev: string; mergeBase: boolean } | undefined {
  const dots = range.indexOf('...');
  const rev = dots === -1 ? range : range.slice(0, dots);
  const right = dots === -1 ? undefined : range.slice(dots + 3);
  if (rev === '' || rev.startsWith('-') || rev.includes('..') || /\s/.test(rev)) return undefined;
  if (right !== undefined && right !== '' && right !== 'HEAD') return undefined;
  return { rev, mergeBase: right !== undefined };
}

/**
 * The working tree at `path` against `range` (the port's grammar), tracked changes and every new file that isn't
 * ignored. A new file is diffed against nothing, which leaves the index alone; `--no-index` exits 1 when the two
 * differ, as a new file always does.
 */
export function diffWorkingTree(path: string, range: string, env?: Readonly<Record<string, string>>): Diff {
  const parsed = parseRange(range);
  if (parsed === undefined) {
    throw new PortError('workspace', 'diff', 'invalid', `'${range}' is not a range: <rev>, <rev>... or <rev>...HEAD`);
  }
  const sha = resolveCommit(path, parsed.rev, env);
  if (sha === undefined) throw new PortError('workspace', 'diff', 'invalid', `${path}: ${parsed.rev} names no commit`);
  let from = sha;
  if (parsed.mergeBase) {
    const base = gitSync(path, ['merge-base', sha, 'HEAD'], env);
    if (base.code !== 0) {
      throw new PortError('workspace', 'diff', 'invalid', `${path}: ${parsed.rev} and HEAD share no commit`);
    }
    from = base.stdout.trim();
  }
  const tracked = gitSync(path, ['diff', '--binary', from, '--'], env);
  if (tracked.code !== 0) throw new PortError('workspace', 'diff', 'unavailable', `${path}: ${tracked.stderr}`);
  const listed = gitSync(path, ['ls-files', '--others', '--exclude-standard', '-z'], env);
  const created = listed.stdout
    .split('\0')
    .filter((file) => file !== '')
    .map((file) => gitSync(path, ['diff', '--no-index', '--binary', '--', '/dev/null', file], env));
  const failed = created.find((result) => result.code !== 1);
  if (listed.code !== 0 || failed !== undefined) {
    throw new PortError('workspace', 'diff', 'unavailable', `${path}: ${(failed ?? listed).stderr}`);
  }
  const patch = tracked.stdout + created.map((result) => result.stdout).join('');
  return { patch, raw: { from, tracked, created } };
}

/**
 * The workspace at `path`, checked to be a worktree of its own, not a directory inside another checkout, and to have
 * `baseSha` as an ancestor of its `HEAD`. Anything else is `invalid`.
 */
export function reopenWorktree(
  path: string,
  branch: string,
  baseSha: string,
  env?: Readonly<Record<string, string>>,
): Workspace {
  const invalid = (why: string) => new PortError('workspace', 'reopen', 'invalid', `${path}: ${why}`);
  if (!existsSync(path)) throw invalid('the workspace is gone');
  const top = gitSync(path, ['rev-parse', '--show-toplevel'], env);
  if (top.code !== 0 || top.stdout.trim() !== realpathSync(path)) throw invalid('the workspace is no git worktree');
  const descends = gitSync(path, ['merge-base', '--is-ancestor', baseSha, 'HEAD'], env);
  if (descends.code !== 0) throw invalid(`its HEAD no longer descends from its base ${baseSha}`);
  return { path, branch, baseSha, raw: null };
}

/** Whether the run in `runDir` has ended, so its workspace can go. A run with no STATUS hasn't. */
function ended(runDir: string): boolean {
  try {
    const { status } = readStatus(runDir);
    return status === 'completed' || status === 'failed';
  } catch {
    return false;
  }
}

/**
 * Removes, through `remove`, the workspace of each ended run under `runsDir`, and gives their paths, sorted. An entry
 * that is a link is no run directory, and is never followed.
 */
export function sweepEnded(runsDir: string, remove: (runDir: string) => void): string[] {
  const paths: string[] = [];
  for (const entry of existsSync(runsDir) ? readdirSync(runsDir) : []) {
    const runDir = join(runsDir, entry);
    const path = join(runDir, WORKSPACE_DIR);
    if (isLink(runDir) || !existsSync(path) || !ended(runDir)) continue;
    remove(runDir);
    paths.push(path);
  }
  return paths.sort();
}

/** `url` without its userinfo: `https://user:token@host/o/r` is `https://host/o/r`. Anything else is kept as it is. */
export function stripUserinfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/** How many times a fetch is tried when it keeps losing git's ref lock to another fetch. */
export const FETCH_TRIES = 4;

/** The waits between those tries, in order. */
export const FETCH_RETRY_WAITS_MS: readonly number[] = [250, 500, 1_000];

/** What git says when another process holds a lock the fetch needs: two runs fetching into one clone at once. */
const LOST_LOCK = /cannot lock ref|Unable to create '[^']*\.lock': File exists/;

/** Waits `ms`, or less when `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      done();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * `git fetch --no-tags <remote>` in `repo`, as a process group killed at `timeoutMs` or when `signal` aborts. Any end
 * but a clean exit is `unavailable`, with what git wrote to stderr. A fetch that lost git's ref lock to another run's
 * fetch in the same clone is tried again, up to `FETCH_TRIES` times with `FETCH_RETRY_WAITS_MS` between them: the
 * winner has usually updated the ref by then. A timeout, an abort and every other failure end it at once.
 */
export async function fetchRemote(
  repo: string,
  remote: string,
  env: Readonly<Record<string, string>> | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const logs = mkdtempSync(join(tmpdir(), 'sail-fetch-'));
  try {
    for (let attempt = 1; ; attempt++) {
      const stderr = join(logs, 'stderr');
      const end = await runProcess({
        command: ['git', 'fetch', '--no-tags', remote],
        cwd: repo,
        env: nonInteractive(env ?? inherited()),
        stdout: join(logs, 'stdout'),
        stderr,
        timeoutMs,
        graceMs: 1_000,
        ...(signal === undefined ? {} : { signal }),
      });
      if (end.started && end.code === 0) return;
      const said = existsSync(stderr) ? readFileSync(stderr, 'utf8').trim() : '';
      const lost = end.started && !end.timedOut && !end.aborted && LOST_LOCK.test(said);
      let stoppedWaiting = false;
      if (lost && attempt < FETCH_TRIES && signal?.aborted !== true) {
        await pause(FETCH_RETRY_WAITS_MS[attempt - 1] ?? 1_000, signal);
        // An abort during the wait ends it here, with this try's message: no further git is started only to be stopped.
        if (signal?.aborted !== true) continue;
        stoppedWaiting = true;
      }
      const how = !end.started
        ? end.message
        : end.timedOut
          ? `timed out after ${timeoutMs} ms`
          : end.aborted || stoppedWaiting
            ? 'stopped'
            : `exited ${end.code ?? end.signal}${attempt > 1 ? ` after ${attempt} tries` : ''}`;
      throw new PortError('workspace', 'create', 'unavailable', `git fetch ${remote} ${how}: ${said}`.trim());
    }
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
}
