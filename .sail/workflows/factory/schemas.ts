// The factory's contracts, shared by its stages and the workflow: what a plan, a validation, a review round and a
// follow-up carry.
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

/** What every committing stage needs to write a commit subject the way this repository does. */
export const CommitInfo = z.object({ ticketKey: z.string(), slug: z.string(), scope: z.string() });

export const Validation = z.object({
  ok: z.boolean(),
  /** Paths left uncommitted. */
  uncommitted: z.array(z.string()),
  /** How `bun run gate` ended. */
  verify: z.object({ ok: z.boolean(), exitCode: z.number().int(), tail: z.string() }),
});

export const Severity = z.enum(['high', 'medium', 'low']);

/** One thing a reviewer found, before the workflow numbers it. */
export const Finding = z.object({
  severity: Severity,
  file: z.string(),
  title: z.string(),
  detail: z.string(),
});

export const NumberedFinding = Finding.extend({ id: z.string() });

export const Triage = z.object({
  finding: z.string(),
  verdict: z.enum(['fix', 'defer', 'reject']),
  rationale: z.string(),
  /** The fix commit's sha, for a `fix`. */
  commit: z.string().nullable(),
});

export const Round = z.object({
  round: z.number().int(),
  findings: z.array(NumberedFinding),
  triage: z.array(Triage),
});

/** Every review round so far, which each later round reads. */
export const History = z.object({ rounds: z.array(Round) });

export const ReviewLens = z.enum(['bugs', 'tests', 'all']);

/** Work a run found and left for later: filed as a ticket of its own once the pull request is open. */
export const FollowUp = z.object({
  title: z.string().max(120),
  description: z.string(),
  type: z.enum(['bug', 'feature', 'refactoring']),
  /** True for a deferred review finding: its ticket also gets the `code-review` label. */
  fromReview: z.boolean(),
});

export const FollowUps = z.object({ followUps: z.array(FollowUp) });
