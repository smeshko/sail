// The factory's contracts, shared by its stages and the workflow: the plan it loads, and why an implement pass didn't
// stand. What a plan carries lives in .sail/lib/plan.ts, beside groom, which writes it.
import { z } from 'sail';
import { AttachedPlan } from '../../lib/plan';
import { Validation } from '../../stages/validate/stage';

/** What load-plan found: the plan attached last, or none, with why. */
export const LoadedPlan = z.object({ plan: AttachedPlan.nullable(), note: z.string() });

/** What every committing stage needs to write a commit subject the way this repository does. */
export const CommitInfo = z.object({ ticketKey: z.string(), slug: z.string(), scope: z.string() });

/** What check-tasks saw: each of the plan's tasks, implemented or not, with what showed it. */
export const TasksChecked = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string(),
        implemented: z.boolean(),
        /** The commit and the files that implement it, or what is missing. */
        evidence: z.string(),
      }),
    )
    .min(1),
});

/**
 * What jev-tasks asked Jev: whether it could, why not when it couldn't, the clear-yes threshold, each task's
 * probability of yes, and the TasksChecked it stands in for when every task is a clear yes (null otherwise).
 */
export const TasksAsked = z.object({
  asked: z.boolean(),
  note: z.string(),
  threshold: z.number(),
  answers: z.array(z.object({ id: z.string(), yes: z.number() })),
  checked: TasksChecked.nullable(),
});

/** Why the last implement pass didn't stand: its validation failed, or a task isn't implemented. */
export const PassFeedback = z.object({
  validation: Validation.nullable(),
  tasks: TasksChecked.nullable(),
});
