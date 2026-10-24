// implement: walks the plan's tasks in order, one commit per task, as implement-plan does. On a plan with tests, each
// task strips its own stickers and makes the locked tests pass through production code.
import { agent, file, value, z } from 'sail';
import { CommitInfo, Lock, Validation } from '../../schemas';

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
    red: file('red.txt').optional(),
    lock: value(Lock),
    commit: value(CommitInfo),
    feedback: value(Validation).optional(),
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
      'bun run test *',
      'bun run typecheck',
      'bun run lint',
      'bun run fix',
      'bun run types',
      'bun run golden',
      'bun .sail/lib/strip-stickers.mjs *',
      'bun .sail/lib/check-tests.mjs *',
      'git add *',
      'git commit *',
      'git diff *',
      'git status *',
      'git log *',
      'git show *',
      'git grep *',
      'git restore *',
    ],
  },
  budget: { maxTurns: 250, maxUsd: 10, maxMinutes: 60 },
});
