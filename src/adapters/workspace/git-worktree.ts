// The built-in `git-worktree` Workspace adapter (ADR-0018, D6): a run works in a detached worktree of the repository at
// `<runDir>/workspace`, made from `<remote>/<default branch>` right after a fetch, so the clone's own checkout, index
// and working files are never touched. Leases are machine-wide, in `~/.sail/leases/`, keyed by the remote's URL with
// any credentials taken out.
//
// It ports the loop's `engine/worktree.ts`: fetch, then `worktree add --detach`, and on release `remove --force`, then
// a plain removal, then `prune`. It refuses to port two things. Nothing is symlinked or copied into the worktree, secrets
// least of all. And a fetch that fails fails the workspace, after the retries a lost ref lock gets: a run never starts
// from a stale base without saying so.
import { join } from 'node:path';
import { z } from 'zod';
import type { ProviderEvent } from '../../events/types';
import type { AdapterDefinition, Env } from '../../ports/adapter';
import { PortError } from '../../ports/errors';
import type { ProviderOptions } from '../../ports/ticket-source';
import type { WorkspacePort } from '../../ports/workspace';
import { defaultLeasesDir, heldLease, releaseLease, takeLease } from '../leases';
import {
  addDetached,
  diffWorkingTree,
  fetchRemote,
  gitSync,
  removeWorktree,
  reopenWorktree,
  resolveCommit,
  stripUserinfo,
  sweepEnded,
  WORKSPACE_DIR,
} from './git';

/** How long a fetch may take before it is killed. */
export const FETCH_TIMEOUT_MS = 120_000;

export interface GitWorktreeOptions extends ProviderOptions {
  /** The clone the worktrees are made from. */
  readonly repo: string;
  /** The git remote to fetch and start from. `origin` when left out. */
  readonly remote?: string;
  /** The branch a run starts from. Left out, what `refs/remotes/<remote>/HEAD` points to. */
  readonly defaultBranch?: string;
  /** Where leases live. `defaultLeasesDir()` when left out. */
  readonly leasesDir?: string;
  /** The environment for every git call. This process's when left out. */
  readonly env?: Readonly<Record<string, string>>;
  readonly fetchTimeoutMs?: number;
}

export function createGitWorktreeWorkspace(options: GitWorktreeOptions): WorkspacePort {
  const now = () => options.now?.() ?? new Date();
  const emit = (event: ProviderEvent) => options.emit?.(event);
  const leasesDir = () => options.leasesDir ?? defaultLeasesDir();
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
      if (result.leased) {
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
    async create(run, { branch, base, signal }) {
      const started = now().getTime();
      await fetchRemote(repo, remote, env, options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS, signal);
      const from = base ?? `${remote}/${defaultBranch()}`;
      const baseSha = resolveCommit(repo, from, env);
      if (baseSha === undefined) throw new PortError('workspace', 'create', 'invalid', `${from} names no commit`);
      const path = join(run.runDir, WORKSPACE_DIR);
      const added = addDetached(repo, path, baseSha, env);
      emit({ type: 'workspace:created', path, branch, baseSha, durationMs: Math.max(0, now().getTime() - started) });
      return { path, branch, baseSha, raw: added };
    },
    async reopen(run, { branch, baseSha }) {
      return reopenWorktree(join(run.runDir, WORKSPACE_DIR), branch, baseSha, env);
    },
    async diff(path, range) {
      return diffWorkingTree(path, range, env);
    },
    async release(run, keep) {
      const path = join(run.runDir, WORKSPACE_DIR);
      const raw = keep ? null : removeWorktree(repo, run.runDir, 'release', env);
      emit({ type: 'workspace:released', path, kept: keep });
      return { path, kept: keep, raw };
    },
    async sweep(runsDir) {
      const paths = sweepEnded(runsDir, (runDir) => removeWorktree(repo, runDir, 'sweep', env));
      return { paths, raw: null };
    },
    capabilities: () => ({ keep: true, sweep: true }),
  };
}

/** The environment without its unset variables, for the git the adapter spawns. */
function definedEnv(env: Env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** `workspace: { use: git-worktree }`: options `remote` and `defaultBranch`, on the repository the run starts in. */
export const gitWorktreeDefinition: AdapterDefinition<WorkspacePort> = {
  create(options, context) {
    const shape = { remote: z.string().min(1).optional(), defaultBranch: z.string().min(1).optional() };
    const parsed = z.strictObject(shape).safeParse(options);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const option = issue?.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue?.path.join('.');
      throw new Error(`git-worktree workspace: option ${option}: ${issue?.message}`);
    }
    const { remote, defaultBranch } = parsed.data;
    return createGitWorktreeWorkspace({
      ...(context.emit === undefined ? {} : { emit: context.emit }),
      ...(context.now === undefined ? {} : { now: context.now }),
      repo: context.root,
      ...(remote === undefined ? {} : { remote }),
      ...(defaultBranch === undefined ? {} : { defaultBranch }),
      env: definedEnv(context.env),
    });
  },
};
