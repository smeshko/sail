// groom's contracts, shared by its intake, stages and workflow: the ticket it reads, what each check finds, what the
// judge decides, and what the act step did.
import { untrusted, z } from 'sail';

export const GroomInput = z.object({
  ticketKey: z.string(),
  title: untrusted(),
  state: z.object({ type: z.string(), name: z.string() }),
  /** The ticket keys of the team's other open tickets, the only ones an action may relate the ticket to. */
  others: z.array(z.string()),
});

/** Other tickets the groomed one may duplicate, each with how sure the check is. */
export const Duplicates = z.object({
  candidates: z.array(z.object({ ticketKey: z.string(), confidence: z.number().min(0).max(1), why: z.string() })),
});

/** Whether the repository already does what the ticket asks. */
export const Staleness = z.object({ stale: z.boolean(), evidence: z.string() });

/** What a planner could not settle from the ticket alone. */
export const Questions = z.object({ questions: z.array(z.string()) });

export const Findings = z.object({ duplicates: Duplicates, staleness: Staleness, questions: Questions });

/** The closed set of things the judge may do to the ticket. */
export const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('duplicate'), of: z.string() }),
  z.object({ kind: z.literal('related'), to: z.string() }),
  z.object({ kind: z.literal('blocks'), to: z.string() }),
  z.object({ kind: z.literal('edit'), title: z.string().optional(), description: z.string().optional() }),
]);

export const Decision = z.object({ summary: z.string(), actions: z.array(Action) });

/** The actions the workflow lets through, and the ones it only reports. */
export const Plan = z.object({ apply: z.array(Action), reported: z.array(z.string()) });

export const Acted = z.object({
  applied: z.array(z.string()),
  reported: z.array(z.string()),
  failed: z.array(z.string()),
  comment: z.string(),
  unlabelled: z.boolean(),
});
