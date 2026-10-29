// groom's contracts, shared by its intake, stages and workflow: the ticket it reads, what each check finds, what the
// judge decides, and what the act step did.
import { untrusted, z } from 'sail';

export const GroomInput = z.object({
  ticketKey: z.string(),
  title: untrusted(),
  description: untrusted(),
  state: z.object({ type: z.string(), name: z.string() }),
  /** The ticket keys of the team's other open tickets, the only ones an action may relate the ticket to. */
  others: z.array(z.string()),
  /** The ticket keys, this one's among them, that groom never cancels or merges away: started tickets and epics. */
  kept: z.array(z.string()),
  /** True when the ticket carries `code-review`: a review filed it, not a person, so groom cancels it more readily. */
  fromReview: z.boolean(),
});

/** The open tickets that describe the same work as the groomed one, each with how sure the check is. */
export const Duplicates = z.object({
  candidates: z.array(z.object({ ticketKey: z.string(), confidence: z.number().min(0).max(1), why: z.string() })),
});

/** Whether the repository already does what the ticket asks. */
export const Staleness = z.object({ stale: z.boolean(), evidence: z.string() });

/** What a planner could not settle from the ticket alone. */
export const Questions = z.object({ questions: z.array(z.string()) });

/**
 * Whether the ticket earns its place: kept, or canceled as not worth doing, each with how sure the check is; and the
 * open tickets it should become one ticket with.
 */
export const Worth = z.object({
  verdict: z.enum(['keep', 'cancel']),
  confidence: z.number().min(0).max(1),
  why: z.string(),
  merges: z.array(z.object({ ticketKey: z.string(), confidence: z.number().min(0).max(1), why: z.string() })),
});

export const Findings = z.object({ duplicates: Duplicates, staleness: Staleness, questions: Questions, worth: Worth });

/** The labels a groomed ticket carries, one of each group as AGENTS.md lists them. */
export const LabelSet = z.object({
  type: z.enum(['feature', 'bug', 'refactoring']),
  platform: z.enum(['core', 'cli', 'dashboard']),
  source: z.enum(['dogfooding', 'code-review', 'field-report']).optional(),
});

/** The closed set of things the judge may do to the ticket. */
export const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('duplicate'), of: z.string() }),
  z.object({ kind: z.literal('related'), to: z.string() }),
  z.object({ kind: z.literal('blocks'), to: z.string() }),
  z.object({ kind: z.literal('edit'), title: z.string().optional(), description: z.string().optional() }),
  z.object({ kind: z.literal('cancel'), reason: z.string() }),
  /**
   * Makes `into` the one ticket for the work of every ticket in `absorb`: its description becomes `description`, which
   * holds each absorbed ask, and each absorbed ticket is marked a duplicate of it, which cancels it. This ticket is
   * `into` or one of `absorb`.
   */
  z.object({ kind: z.literal('merge'), into: z.string(), absorb: z.array(z.string()), description: z.string() }),
  z.object({ kind: z.literal('labels'), set: LabelSet }),
]);

export const Decision = z.object({
  summary: z.string(),
  actions: z.array(Action),
  /** The open questions the judge confirmed, which a person must answer before the ticket is planned. */
  questions: z.array(z.string()),
});

/** The actions the workflow lets through, the ones it only reports, and the label the groomed ticket ends with. */
export const Plan = z.object({
  apply: z.array(Action),
  reported: z.array(z.string()),
  outcome: z.enum(['groomed', 'open-questions']),
});

export const Acted = z.object({
  applied: z.array(z.string()),
  reported: z.array(z.string()),
  failed: z.array(z.string()),
  comment: z.string(),
  unlabelled: z.boolean(),
  labelled: z.string(),
});
