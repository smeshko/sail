import type { Builtins } from '../ports/adapter';
import { claudeCodeAdapters } from './claude-code/index';
import { githubCodeHost } from './code-host/github';
import { fakeAdapters } from './fake/index';
import { typesafeJev } from './jev/typesafe';
import { linearTicketSource } from './ticket-source/linear';
import { gitWorktreeDefinition } from './workspace/git-worktree';

export { createClaudeCodeHarness } from './claude-code/index';
export { createGitHubCodeHost } from './code-host/github';
export {
  createFakeCodeHost,
  createFakeHarness,
  createFakeJev,
  createFakeTicketSource,
  createFakeWorkspace,
} from './fake/index';
export { createTypesafeJev } from './jev/typesafe';
export { createLinearTicketSource } from './ticket-source/linear';
export { createGitWorktreeWorkspace } from './workspace/git-worktree';

/** The built-in adapters by name: the set a composition root hands to the adapter registry. */
export const BUILTINS: Builtins = {
  fake: fakeAdapters,
  linear: { ticketSource: linearTicketSource },
  'claude-code': claudeCodeAdapters,
  'git-worktree': { workspace: gitWorktreeDefinition },
  github: { codeHost: githubCodeHost },
  typesafe: { jev: typesafeJev },
};
