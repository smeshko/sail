// The factory's contracts, shared by its stages and the workflow: what a plan carries, and why an implement pass
// didn't stand.
import { z } from 'sail';
import { Validation } from '../../stages/validate/stage';

export const Risk = z.enum(['tiny', 'small', 'medium', 'large', 'high']);

export const Task = z.object({
  id: z.string().regex(/^TASK-\d{3}$/),
  title: z.string(),
  /** `impl` is code work, red then green; `checklist` is anything else. */
  type: z.enum(['impl', 'checklist']),
  /** The task's commit subject, without the ticket reference. */
  commit: z.string(),
});

export const PlanOutput = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  /** The Conventional Commits scope the plan's commits share. */
  scope: z.string(),
  risk: Risk,
  tasks: z.array(Task).min(1),
});

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

/** Why the last implement pass didn't stand: its validation failed, or a task isn't implemented. */
export const PassFeedback = z.object({
  validation: Validation.nullable(),
  tasks: TasksChecked.nullable(),
});
