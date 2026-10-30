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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { withoutRepositoryVariables } from '../../engine/git-env';
import { runProcess } from '../../engine/process';
import { readStatus } from '../../engine/run-dir';
import { RUN_HEADER_FILE } from '../../engine/run-header';
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
 * fails, as `unavailable`, when the run directory is a link, a link at the path can't be unlinked, or the path is still
 * there.
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
    try {
      unlinkSync(path);
    } catch (error) {
      throw new PortError('workspace', op, 'unavailable', `${path}: ${(error as Error).message}`);
    }
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

/** The run ref, where a removed workspace's commits are kept: outside `refs/heads/`, so `git branch` never lists it. */
export const runRef = (runId: string): string => `refs/sail/runs/${runId}`;

/**
 * The base `run.json` in `runDir` records, or undefined when there is none. Only `repository.baseSha` is read, so a
 * header that has since broken `sail.run.v1` still names its base.
 */
function recordedBase(runDir: string): string | undefined {
  try {
    const header = JSON.parse(readFileSync(join(runDir, RUN_HEADER_FILE), 'utf8'));
    const baseSha = header?.repository?.baseSha;
    return typeof baseSha === 'string' ? baseSha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Points `runRef(runId)` in `repo` at the `HEAD` of the run's workspace, when that is a commit other than the base
 * `run.json` records and no remote-tracking ref reaches: a run that never pushed its branch has nothing else reaching its commits once the worktree goes,
 * and git's gc deletes them. The adapter compares against the run's record, since a workspace is released by a process
 * that may never have made it. A workspace with no recorded base is a start's refused before `run.json`, which ran no
 * step, and a link is never looked into, since its `HEAD` is another checkout's. It gives the ref and the commit, or
 * what failed when the ref couldn't be written.
 */
function keepHead(
  repo: string,
  run: { runId: string; runDir: string },
  env?: Readonly<Record<string, string>>,
): { ref: string; head: string } | { failed: string } | undefined {
  const path = resolve(run.runDir, WORKSPACE_DIR);
  const base = recordedBase(run.runDir);
  if (base === undefined || isLink(run.runDir) || isLink(path)) return undefined;
  const shown = gitSync(path, ['rev-parse', '--show-toplevel', 'HEAD'], env);
  const [top, head] = shown.stdout.trim().split('\n');
  if (shown.code !== 0 || top !== realpathSync(path) || head === undefined || head === base) return undefined;
  // A head a remote-tracking ref reaches was pushed, as a pull request's head is: the remote keeps it already.
  const pushed = gitSync(
    path,
    ['for-each-ref', '--contains', head, '--count=1', '--format=%(refname)', 'refs/remotes'],
    env,
  );
  if (pushed.code === 0 && pushed.stdout.trim() !== '') return undefined;
  const ref = runRef(run.runId);
  const wrote = gitSync(repo, ['update-ref', ref, head], env);
  if (wrote.code !== 0) return { failed: `its commits at ${head} were not kept at ${ref}: ${wrote.stderr}` };
  return { ref, head };
}

/**
 * Removes the run's workspace for good, for a release or a sweep (`op`): keeps its commits at `runRef()` as
 * `keepHead()` does, then removes it with `removeWorktree()`. A ref that can't be written doesn't stop the removal: `op`
 * then fails as `unavailable`, saying so, and with the removal's own failure after it when there is one.
 */
export function releaseWorktree(
  repo: string,
  run: { runId: string; runDir: string },
  op: string,
  env?: Readonly<Record<string, string>>,
): { raw: GitResult; ref?: string; head?: string } {
  const kept = keepHead(repo, run, env);
  const failed = kept !== undefined && 'failed' in kept ? kept.failed : undefined;
  let removed: GitResult;
  try {
    removed = removeWorktree(repo, run.runDir, op, env);
  } catch (error) {
    if (failed === undefined || !(error instanceof PortError)) throw error;
    const why = error.message.slice(`workspace.${op}: `.length);
    throw new PortError('workspace', op, 'unavailable', `${failed}; ${why}`);
  }
  if (failed !== undefined) throw new PortError('workspace', op, 'unavailable', failed);
  return { raw: removed, ...(kept === undefined || 'failed' in kept ? {} : kept) };
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
 * Copies the files of commit `sha` under `paths` into `into`, at the same relative paths, and leaves the working tree
 * alone. A path the commit lacks is skipped. A blob keeps its executable bit, a symbolic link stays one, and a
 * submodule is skipped. A `sha` that names no commit is `invalid`.
 */
export function copyTree(
  repo: string,
  sha: string,
  paths: readonly string[],
  into: string,
  env?: Readonly<Record<string, string>>,
): void {
  const invalid = (why: string) => new PortError('workspace', 'readTree', 'invalid', why);
  if (resolveCommit(repo, sha, env) === undefined) throw invalid(`${sha} names no commit`);
  if (paths.length === 0) return;
  const listed = gitSync(repo, ['ls-tree', '-r', '-z', '--full-tree', sha, '--', ...paths], env);
  if (listed.code !== 0) throw new PortError('workspace', 'readTree', 'unavailable', listed.stderr);
  for (const entry of listed.stdout.split('\0').filter((each) => each !== '')) {
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    const file = entry.slice(tab + 1);
    if (type !== 'blob' || oid === undefined) continue;
    const blob = Bun.spawnSync(['git', 'cat-file', 'blob', oid], {
      cwd: repo,
      env: nonInteractive(env ?? inherited()),
      stdin: 'ignore',
      timeout: LOCAL_TIMEOUT_MS,
    });
    if (blob.exitCode !== 0) {
      throw new PortError('workspace', 'readTree', 'unavailable', `${file}: ${blob.stderr.toString().trim()}`);
    }
    const target = join(into, file);
    mkdirSync(dirname(target), { recursive: true });
    if (mode === '120000') symlinkSync(blob.stdout.toString(), target);
    else writeFileSync(target, blob.stdout, { mode: mode === '100755' ? 0o755 : 0o644 });
  }
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
 * Removes, through `remove`, each ended run's workspace under `runsDir`, continuing after any removal throws. Returns
 * removed paths and failed paths with reasons, both sorted by path. A linked run directory is never followed.
 */
export function sweepEnded(
  runsDir: string,
  remove: (runDir: string) => void,
): { paths: string[]; failed: { path: string; reason: string }[] } {
  const paths: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  for (const entry of existsSync(runsDir) ? readdirSync(runsDir) : []) {
    const runDir = join(runsDir, entry);
    const path = join(runDir, WORKSPACE_DIR);
    if (isLink(runDir) || !existsSync(path) || !ended(runDir)) continue;
    try {
      remove(runDir);
      paths.push(path);
    } catch (error) {
      const reason =
        error instanceof PortError
          ? error.message.slice('workspace.sweep: '.length)
          : error instanceof Error
            ? error.message
            : String(error);
      failed.push({ path, reason });
    }
  }
  return { paths: paths.sort(), failed: failed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
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

/** Whether `signal` has aborted, read afresh at each call. */
const stopped = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

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
 * `git fetch --no-tags --prune <remote>` in `repo`, as a process group killed at `timeoutMs` or when `signal` aborts. It
 * prunes so a branch deleted on the remote leaves no tracking ref to be taken for it. Any end but a clean exit is `unavailable`, with what git wrote to stderr. A fetch that lost git's ref lock to another run's
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
        command: ['git', 'fetch', '--no-tags', '--prune', remote],
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
      if (lost && attempt < FETCH_TRIES && !stopped(signal)) {
        await pause(FETCH_RETRY_WAITS_MS[attempt - 1] ?? 1_000, signal);
        // An abort during the wait ends it here, with this try's message: no further git is started only to be stopped.
        if (!stopped(signal)) continue;
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
