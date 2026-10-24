// The factory's contracts, shared by its stages and the workflow: what a plan, a test proof, a validation and a review
// round carry.
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

/** One pending test, as the agent that wrote it names it. */
export const PendingTest = z.object({ task: z.string(), file: z.string(), name: z.string() });

export const TestsWritten = z.object({
  cases: z.array(PendingTest),
  /** Why the plan needs no new test, when `cases` is empty: a pure refactor the existing suite covers. */
  none: z.string().nullable(),
});

/** What proving the pending tests found: each problem, and each test's red failure. */
export const Proof = z.object({
  ok: z.boolean(),
  problems: z.array(z.string()),
  red: z.array(z.object({ task: z.string(), file: z.string(), name: z.string(), message: z.string() })),
});

export const TestsCommitted = z.object({ stubsCommit: z.string().nullable(), testsCommit: z.string() });

/** The lock the validation checks the tests against: none when the plan wrote no tests. */
export const Lock = z.object({ testsCommit: z.string().nullable() });

export const Validation = z.object({
  ok: z.boolean(),
  /** Paths left uncommitted. */
  uncommitted: z.array(z.string()),
  /** Tests changed beyond their stickers, and stickers left. */
  violations: z.array(z.string()),
  amendments: z.array(z.string()),
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
