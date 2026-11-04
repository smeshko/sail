// What a plan carries, shared by groom, which writes the plan and attaches it to the ticket, and the factory, which
// reads it back and implements it. The attached plan.md ends with one `<!-- sail:plan {…} -->` line, the AttachedPlan,
// so the factory reads the plan's structured part from the same file a person reads.
import { z } from 'sail';

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

/**
 * The trailer of an attached plan: its PlanOutput, the groom run that wrote it, the commit its workspace stood on, and
 * when it was attached. When a ticket carries several plans, the factory implements the one attached last.
 */
export const AttachedPlan = PlanOutput.extend({
  version: z.literal(1),
  run: z.string(),
  base: z.string(),
  attachedAt: z.string().datetime(),
});
