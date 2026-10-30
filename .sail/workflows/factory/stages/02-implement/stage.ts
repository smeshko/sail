// implement: walks the plan's tasks in order, test first, one commit per task: red, green, refactor, commit.
import { agent, file, value, z } from 'sail';
import { builder, withTools } from '../../../../lib/permissions';
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
  permissions: withTools(builder, ['WebFetch']),
  budget: { maxTurns: 250, maxUsd: 10, maxMinutes: 90 },
});
