// The built-in `git-worktree` Workspace adapter (ADR-0018, D6): a run works in a detached worktree of the repository at
// `<runDir>/workspace`, made right after a fetch from the run's branch on `<remote>` when it has one, else from
// `<remote>/<default branch>`, so the clone's own checkout, index
// and working files are never touched. Leases are shared within the selected machine directory, in `$SAIL_HOME/leases/`
// (or `~/.sail/leases/`), keyed by the remote's URL with any credentials taken out.
//
// It ports the loop's `engine/worktree.ts`: fetch, then `worktree add --detach`, and on release `remove --force`, then
// a plain removal, then `prune`. It refuses to port two things. Nothing is symlinked or copied into the worktree, secrets
// least of all. And a fetch that fails fails the workspace, after the retries a lost ref lock gets: a run never starts
// from a stale base without saying so.
//
// Its `setup` option is the workspace setup: a shell command run in each workspace it makes, such as `bun install
// --frozen-lockfile`, before the workspace is handed out. Every run's workspace gets it, a seeded run's included, whose
// reused calls can't have left anything in a workspace that is new. A setup that fails, times out or is stopped fails
// the create, and the workspace is removed again.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { withoutRepositoryVariables } from '../../engine/git-env';
import { runProcess } from '../../engine/process';
import type { ProviderEvent } from '../../events/types';
import type { AdapterDefinition, Env } from '../../ports/adapter';
import { PortError } from '../../ports/errors';
import type { ProviderOptions } from '../../ports/ticket-source';
import type { WorkspacePort } from '../../ports/workspace';
import { defaultLeasesDir, heldLease, releaseLease, takeLease } from '../leases';
import {
  addDetached,
  copyTree,
  diffWorkingTree,
  fastForwardClone,
  fetchRemote,
  gitSync,
  releaseWorktree,
  removeWorktree,
  reopenWorktree,
  resolveCommit,
  stripUserinfo,
  sweepEnded,
  WORKSPACE_DIR,
} from './git';

/** How long a fetch may take before it is killed. */
export const FETCH_TIMEOUT_MS = 120_000;

/** How long the workspace setup may take before it is killed. */
export const SETUP_TIMEOUT_MS = 600_000;

/** How many of its last lines of output a failed setup's message quotes. */
const SETUP_TAIL_LINES = 20;

export interface GitWorktreeOptions extends ProviderOptions {
  /** The clone the worktrees are made from. */
  readonly repo: string;
  /** The git remote to fetch and start from. `origin` when left out. */
  readonly remote?: string;
  /** The branch a run starts from. Left out, what `refs/remotes/<remote>/HEAD` points to. */
  readonly defaultBranch?: string;
  /** Where leases live. `defaultLeasesDir(env)` when left out. */
  readonly leasesDir?: string;
  /** The environment for every git call. This process's when left out. */
  readonly env?: Readonly<Record<string, string>>;
  readonly fetchTimeoutMs?: number;
  /** The workspace setup: a shell command run in each new workspace before it is handed out. None when left out. */
  readonly setup?: string;
  readonly setupTimeoutMs?: number;
}

/**
 * Runs the workspace setup `command` with `sh -c` in the workspace at `path`. It fails as `unavailable`, quoting the
 * end of what it printed, when it can't start, exits non-zero, times out or is stopped.
 */
async function setUp(
  command: string,
  path: string,
  env: Readonly<Record<string, string>> | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const logs = mkdtempSync(join(tmpdir(), 'sail-setup-'));
  try {
    const stdout = join(logs, 'stdout');
    const stderr = join(logs, 'stderr');
    const end = await runProcess({
      command: ['sh', '-c', command],
      cwd: path,
      env: withoutRepositoryVariables(env ?? process.env),
      stdout,
      stderr,
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    if (end.started && end.code === 0 && !end.timedOut && !end.aborted) return;
    const printed = [stdout, stderr].map((file) => readFileSync(file, 'utf8').trim()).filter((each) => each !== '');
    const tail = printed.join('\n').split('\n').slice(-SETUP_TAIL_LINES).join('\n');
    const how = !end.started
      ? end.message
      : end.timedOut
        ? `timed out after ${timeoutMs} ms`
        : end.aborted
          ? 'stopped'
          : `exited ${end.code ?? end.signal}`;
    throw new PortError('workspace', 'create', 'unavailable', `setup \`${command}\` ${how}: ${tail}`.trim());
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
}

export function createGitWorktreeWorkspace(options: GitWorktreeOptions): WorkspacePort {
  const now = () => options.now?.() ?? new Date();
  const emit = (event: ProviderEvent) => options.emit?.(event);
  const leasesDir = () => options.leasesDir ?? defaultLeasesDir(options.env ?? process.env);
  const { repo, env } = options;
  const remote = options.remote ?? 'origin';

  /** The default branch: the option, or the remote's `HEAD`. Neither is `invalid`, saying how to set one. */
  const defaultBranch = (): string => {
    if (options.defaultBranch !== undefined) return options.defaultBranch;
    const head = gitSync(repo, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], env);
    const prefix = `refs/remotes/${remote}/`;
    const ref = head.stdout.trim();
    if (head.code === 0 && ref.startsWith(prefix)) return ref.slice(prefix.length);
    throw new PortError(
      'workspace',
      'repository',
      'invalid',
      `${remote} has no default branch: run git remote set-head ${remote} --auto, or set the defaultBranch option`,
    );
  };

  return {
    name: 'git-worktree',
    async repository() {
      const url = gitSync(repo, ['remote', 'get-url', remote], env);
      if (url.code !== 0) {
        throw new PortError('workspace', 'repository', 'invalid', `no remote '${remote}' in ${repo}: ${url.stderr}`);
      }
      return { url: stripUserinfo(url.stdout.trim()), defaultBranch: defaultBranch(), raw: null };
    },
    async lease(leased, branch, holder) {
      const result = takeLease(leasesDir(), leased, branch, holder, now());
      if (result.leased && !holder.suspended) {
        const took = result.took === undefined ? {} : { took: result.took };
        emit({ type: 'workspace:leased', remote: leased, branch, ...took });
      }
      return result;
    },
    async releaseLease(leased, branch, runId) {
      const result = releaseLease(leasesDir(), leased, branch, runId);
      if (result.released) emit({ type: 'workspace:lease_released', remote: leased, branch });
      return result;
    },
    async holder(leased, branch) {
      return heldLease(leasesDir(), leased, branch);
    },
    async create(run, { branch, base, fallback, signal }) {
      const started = now().getTime();
      await fetchRemote(repo, remote, env, options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS, signal);
      // A rerun whose branch is already on the remote continues it, so its push is a fast-forward.
      const from =
        base ??
        (resolveCommit(repo, `refs/remotes/${remote}/${branch}`, env)
          ? `refs/remotes/${remote}/${branch}`
          : (fallback ?? `${remote}/${defaultBranch()}`));
      const baseSha = resolveCommit(repo, from, env);
      if (baseSha === undefined) throw new PortError('workspace', 'create', 'invalid', `${from} names no commit`);
      const path = join(run.runDir, WORKSPACE_DIR);
      const added = addDetached(repo, path, baseSha, env);
      if (options.setup !== undefined) {
        try {
          await setUp(options.setup, path, env, options.setupTimeoutMs ?? SETUP_TIMEOUT_MS, signal);
        } catch (error) {
          // The setup's failure is the one to report: a removal that fails too leaves a workspace a sweep takes.
          try {
            removeWorktree(repo, run.runDir, 'create', env);
          } catch {}
          throw error;
        }
      }
      emit({ type: 'workspace:created', path, branch, baseSha, durationMs: Math.max(0, now().getTime() - started) });
      return { path, branch, baseSha, raw: added };
    },
    async readTree(into, { paths, base, signal }) {
      if (base === undefined) await fetchRemote(repo, remote, env, options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS, signal);
      const from = base ?? `${remote}/${defaultBranch()}`;
      const sha = resolveCommit(repo, from, env);
      if (sha === undefined) throw new PortError('workspace', 'readTree', 'invalid', `${from} names no commit`);
      copyTree(repo, sha, paths, into, env);
      return { sha };
    },
    async fastForward({ signal } = {}) {
      await fetchRemote(repo, remote, env, options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS, signal);
      return fastForwardClone(repo, remote, defaultBranch(), env);
    },
    async reopen(run, { branch, baseSha }) {
      return reopenWorktree(join(run.runDir, WORKSPACE_DIR), branch, baseSha, env);
    },
    async diff(path, range) {
      return diffWorkingTree(path, range, env);
    },
    async release(run, keep) {
      const path = join(run.runDir, WORKSPACE_DIR);
      if (keep) {
        emit({ type: 'workspace:released', path, kept: keep });
        return { path, kept: keep, raw: null };
      }
      const { raw, ...commits } = releaseWorktree(repo, run, 'release', env);
      emit({ type: 'workspace:released', path, kept: keep, ...commits });
      return { path, kept: keep, ...commits, raw };
    },
    async sweep(runsDir) {
      const swept = sweepEnded(runsDir, (runDir) =>
        releaseWorktree(repo, { runId: basename(runDir), runDir }, 'sweep', env),
      );
      return { ...swept, raw: null };
    },
    capabilities: () => ({ keep: true, sweep: true }),
  };
}

/** The environment without its unset variables, for the git the adapter spawns. */
function definedEnv(env: Env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/**
 * `workspace: { use: git-worktree }`: options `remote`, `defaultBranch` and `setup`, on the repository the run starts
 * in.
 */
export const gitWorktreeDefinition: AdapterDefinition<WorkspacePort> = {
  create(options, context) {
    const shape = {
      remote: z.string().min(1).optional(),
      defaultBranch: z.string().min(1).optional(),
      setup: z.string().min(1).optional(),
    };
    const parsed = z.strictObject(shape).safeParse(options);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const option = issue?.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue?.path.join('.');
      throw new Error(`git-worktree workspace: option ${option}: ${issue?.message}`);
    }
    const { remote, defaultBranch, setup } = parsed.data;
    return createGitWorktreeWorkspace({
      ...(context.emit === undefined ? {} : { emit: context.emit }),
      ...(context.now === undefined ? {} : { now: context.now }),
      repo: context.root,
      ...(remote === undefined ? {} : { remote }),
      ...(defaultBranch === undefined ? {} : { defaultBranch }),
      ...(setup === undefined ? {} : { setup }),
      env: definedEnv(context.env),
    });
  },
};
