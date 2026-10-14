import type { Builtins } from '../ports/adapter';
import { claudeCodeAdapters } from './claude-code/index';
import { fakeAdapters } from './fake/index';
import { linearTicketSource } from './ticket-source/linear';
import { gitWorktreeDefinition } from './workspace/git-worktree';

export { createClaudeCodeHarness } from './claude-code/index';
export { createFakeCodeHost, createFakeHarness, createFakeTicketSource, createFakeWorkspace } from './fake/index';
export { createLinearTicketSource } from './ticket-source/linear';
export { createGitWorktreeWorkspace } from './workspace/git-worktree';

/** The built-in adapters by name: the set a composition root hands to the adapter registry. */
export const BUILTINS: Builtins = {
  fake: fakeAdapters,
  linear: { ticketSource: linearTicketSource },
  'claude-code': claudeCodeAdapters,
  'git-worktree': { workspace: gitWorktreeDefinition },
};
