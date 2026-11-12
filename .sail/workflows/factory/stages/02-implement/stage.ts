// implement: walks the plan's tasks in order, test first, one commit per task that changes a file: red, green, refactor, commit.
import { agent, file, value, z } from 'sail';
import { builder, withTools } from '../../../../lib/permissions';
import { CommitInfo, PassFeedback } from '../../schemas';

export const Implemented = z.object({
  tasks: z.array(
    z
      .object({
        id: z.string(),
        /** The task's commit, or null for a task that changed no file. */
        commit: z.string().nullable(),
        /**
         * What proves the task's acceptance: the tests that went green, a transcript, a log line. Required, and not
         * blank, for a task with no commit: it is printed in the pull request's body.
         */
        evidence: z.string(),
      })
      // A malformed one is invalid output, so it gets a corrective try.
      .superRefine((task, context) => {
        if (task.commit === null && task.evidence.trim() === '') {
          context.addIssue({
            code: 'custom',
            path: ['evidence'],
            message: 'a task with no commit needs its evidence: what was run and what it printed',
          });
        }
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
  // It writes code, docs and commits, which carry the vocabulary.
  conventions: ['AGENTS.md', 'CONTEXT.md'],
  model: 'default',
  permissions: withTools(builder, ['WebFetch']),
  budget: { maxTurns: 250, maxUsd: 10, maxMinutes: 90 },
});
