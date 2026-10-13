// The git-worktree adapter as an adapter definition: the workspace port, which takes no options in this phase. The
// repository is the clone the run belongs to, and git runs with the environment the run resolved (ADR-0018).
import type { AdapterContext, AdapterDefinition, AdapterOptions, Env } from '../../ports/adapter';
import type { WorkspacePort } from '../../ports/workspace';
import { createGitWorktreeWorkspace } from './index';

/** The environment without its unset variables, for the git the adapter runs. */
function definedEnv(env: Env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

const provider = (context: AdapterContext) => ({
  ...(context.emit === undefined ? {} : { emit: context.emit }),
  ...(context.now === undefined ? {} : { now: context.now }),
});

export const gitWorktreeAdapters: { workspace: AdapterDefinition<WorkspacePort> } = {
  workspace: {
    create(options: AdapterOptions, context: AdapterContext) {
      if (Object.keys(options).length > 0) {
        throw new Error(`git-worktree workspace takes no options, got ${Object.keys(options).join(', ')}`);
      }
      return createGitWorktreeWorkspace({ ...provider(context), repo: context.root, env: definedEnv(context.env) });
    },
  },
};
