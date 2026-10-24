// implement: walks the plan's tasks in order, test first, one commit per task: red, green, refactor, commit.
import { agent, file, value, z } from 'sail';
import { CommitInfo, PassFeedback } from '../../schemas';

export const Implemented = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      /** The task's commit, or null for a task that needed no change. */
      commit: z.string().nullable(),
      /** What proves the task's acceptance: the tests that went green, a transcript, a log line. */
      evidence: z.string(),
    }),
  ),
  /** Where the work diverged from the plan, and why. */
  notes: z.string().max(1200),
});

export const implement = agent('implement', {
  prompt: './prompt.md',
  consumes: {
    plan: file('plan.md'),
    commit: value(CommitInfo),
    feedback: value(PassFeedback).optional(),
  },
  output: Implemented,
  model: 'default',
  permissions: {
    read: ['**'],
    write: ['src/**', 'test/**', 'types/**', 'schemas/**', 'bin/**', 'scripts/**', 'CONTEXT.md', '$STAGE_OUT/**'],
    commands: [
      'cat *',
      'grep *',
      'head *',
      'tail *',
      'wc *',
      'ls *',
      'bun run test *',
      'bun run typecheck',
      'bun run lint',
      'bun run fix',
      'bun run types',
      'bun run golden',
      'git add *',
      'git commit *',
      'git diff *',
      'git status *',
      'git log *',
      'git show *',
      'git grep *',
      'git rev-parse *',
      'git restore *',
    ],
  },
  budget: { maxTurns: 250, maxUsd: 10, maxMinutes: 60 },
});
