// review's contracts, shared by its stages and the workflow: what a reviewer finds, what the judge decides, and how
// each fix round went.
import { z } from 'sail';
import { FollowUp } from '../../stages/file-follow-ups/stage';
import { Validation } from '../../stages/validate/stage';

export const Severity = z.enum(['high', 'medium', 'low']);

/** One thing a reviewer found, before the workflow numbers it. */
export const Finding = z.object({
  severity: Severity,
  file: z.string(),
  title: z.string(),
  detail: z.string(),
});

/** The reviewers, one stage each. */
export const Lens = z.enum(['requirements', 'architecture', 'bugs', 'tests', 'security', 'conventions']);

/** What found it: validation, the leak check, the demonstration, one reviewer, or check-fix reviewing the fixes. */
export const Source = z.enum(['validate', 'leak-check', 'demonstrate', ...Lens.options, 'check-fix']);

/**
 * A finding the workflow numbered: `V1` from validation, `L<n>` from the leak check, `D<n>` from the demonstration,
 * `R<n>` from a reviewer, and `F<round>-<n>` from check-fix.
 */
export const NumberedFinding = Finding.extend({ id: z.string(), source: Source });

export const Findings = z.object({ findings: z.array(NumberedFinding) });

/** What the demonstrate stage saw: each requirement it could show, shown or not, with what showed it. */
export const Demonstrated = z.object({
  criteria: z.array(
    z.object({
      criterion: z.string(),
      shown: z.boolean(),
      /** What was observed: the output line, the event and its field, the element's text, quoted. */
      evidence: z.string(),
    }),
  ),
  /** Why nothing could be shown, when nothing a user runs changes: a refactor, types, docs. Null otherwise. */
  skipped: z.string().nullable(),
  /** The commands run and what they printed, cut to what shows the criteria. */
  transcript: z.string().max(4000),
});

/**
 * One thing a reviewer checked, and how: the record that tells a review from a skim. `holds` when it checked out,
 * `finding` when a finding came of it, `unchecked` when the reviewer couldn't check it, with why.
 */
export const Checked = z.object({
  what: z.string(),
  how: z.string(),
  status: z.enum(['holds', 'finding', 'unchecked']),
});

export const Reviewed = z.object({
  summary: z.string(),
  /** Everything the lens's checklist asked of this change, each checked or said why not. */
  coverage: z.array(Checked).min(1),
  findings: z.array(Finding),
});

/** What the judge read beside the findings: how each check went as a whole. */
export const Evidence = z.object({
  validation: Validation,
  demonstration: Demonstrated,
  reviews: z.array(z.object({ lens: Lens, summary: z.string(), coverage: z.array(Checked) })),
});

export const Verdict = z.enum(['fix', 'ticket', 'drop']);

export const Judgement = z.object({
  /** The pull request's state in a paragraph: what holds, and what doesn't. */
  summary: z.string(),
  /** The reviews too thin to trust: a lens whose coverage leaves out what the change needed checked. */
  thin: z.array(z.object({ lens: Lens, why: z.string() })),
  decisions: z.array(
    z.object({
      finding: z.string(),
      verdict: Verdict,
      rationale: z.string(),
      /** The ticket to file, for a `ticket`. Null otherwise. */
      ticket: FollowUp.omit({ fromReview: true }).nullable(),
    }),
  ),
});

export const Fixed = z.object({
  fixes: z.array(
    z.object({
      finding: z.string(),
      /** The fix's commit, or null when this pass made none for it. */
      commit: z.string().nullable(),
      note: z.string(),
    }),
  ),
});

export const FixChecked = z.object({
  /** Each finding the fixes target, resolved or not. */
  items: z.array(z.object({ finding: z.string(), resolved: z.boolean(), detail: z.string() })),
  /** Problems the fixes themselves introduced. */
  findings: z.array(Finding),
});

/** Why the last fix pass didn't stand: what is still open, what the fixes broke, and a failed validation. */
export const FixFeedback = z.object({
  open: z.array(z.object({ finding: z.string(), detail: z.string() })),
  fresh: z.array(NumberedFinding),
  validation: Validation.nullable(),
});

/** Everything the review did, for its pull request comment. */
export const ReviewRecord = z.object({
  findings: z.array(NumberedFinding),
  judgement: Judgement.nullable(),
  rounds: z.array(z.object({ round: z.number().int(), fixed: Fixed, checked: FixChecked, validated: z.boolean() })),
  /** True when every fix held and validation passed. */
  resolved: z.boolean(),
  /** The reviews the judge found too thin to trust: each stops the merge. */
  thin: Judgement.shape.thin,
  open: z.array(z.object({ finding: z.string(), detail: z.string() })),
});
