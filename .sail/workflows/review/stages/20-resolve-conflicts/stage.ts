// resolve-conflicts: finishes the merge of the base that sync-base left conflicted, keeping what the pull request does
// and what the base changed, then commits it. Validation runs after it.
import { agent, file, value, z } from 'sail';
import { Synced } from '../19-sync-base/stage';

export const Resolved = z.object({
  /** The merge commit, or null when the agent left the merge unfinished. */
  commit: z.string().nullable(),
  /** How each conflict was resolved, or why one couldn't be. */
  note: z.string(),
});

export const resolveConflicts = agent('resolve-conflicts', {
  prompt: './prompt.md',
  consumes: { requirements: file('requirements.md'), synced: value(Synced) },
  output: Resolved,
  model: 'sol',
  permissions: {
    read: ['**'],
    write: [
      'src/**',
      'test/**',
      'types/**',
      'schemas/**',
      'bin/**',
      'scripts/**',
      '.sail/**',
      '.githooks/**',
      'package.json',
      'bun.lock',
      'bunfig.toml',
      'tsconfig.json',
      'biome.json',
      'AGENTS.md',
      'CONTEXT.md',
      '$STAGE_OUT/**',
    ],
    commands: [
      'cat *',
      'grep *',
      'head *',
      'tail *',
      'wc *',
      'ls *',
      'sed -n *',
      'echo *',
      'bun run test *',
      'bun run typecheck',
      'bun run lint',
      'bun run fix',
      'bun run types',
      'bun run golden',
      'git add *',
      'git commit --no-edit',
      'git diff *',
      'git status *',
      'git log *',
      'git show *',
      'git grep *',
      'git rev-parse *',
    ],
  },
  budget: { maxTurns: 80, maxUsd: 4, maxMinutes: 30 },
});
