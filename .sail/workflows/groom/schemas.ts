// groom's contracts, shared by its intake, stages and workflow: the ticket it reads, what each check finds, what the
// judge decides, what the planner wrote, which ticket's plan overlaps it, what the act step did, and whether the
// rulings stage found the ticket's rulings to answer every earlier open question (Ruled).
import { untrusted, z } from 'sail';
import { PlanOutput } from '../../lib/plan';

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

/**
 * Whether the duplicates, worth and questions checks can be skipped: the ticket's `## Rulings` answer every open
 * question the last grooming asked. `asked` says whether Jev answered, `note` why not skipped, `questions` how many
 * earlier questions were found, and `answers` Jev's probability of yes for each.
 */
export const Ruled = z.object({
  skip: z.boolean(),
  asked: z.boolean(),
  note: z.string(),
  threshold: z.number(),
  questions: z.number(),
  answers: z.array(z.object({ id: z.string(), yes: z.number() })),
});

/** The open tickets Jev ranks closest to the groomed one, each with its score. */
export const Duplicates = z.object({
  candidates: z.array(z.object({ ticketKey: z.string(), confidence: z.number().min(0).max(1), why: z.string() })),
  /** Why Jev could not be asked, with no candidates; absent when the check ran. */
  unchecked: z.string().optional(),
});

/**
 * One open question, answerable where it is read: two to four options and what each means day to day, the option
 * recommended and why, and the `file:line` it rests on. A malformed one is invalid output, so it gets a corrective try.
 */
export const Question = z
  .object({
    ask: z.string().refine((ask) => ask.includes('?'), 'ask must contain a "?"'),
    options: z
      .array(z.object({ option: z.string(), means: z.string() }))
      .min(2)
      .max(4),
    recommend: z.string(),
    why: z.string(),
    cites: z.array(z.string().regex(/^\S+:\d+(-\d+)?$/, 'a cite is file:line or file:line-line')).min(1),
  })
  .superRefine((question, context) => {
    if (!question.options.some((each) => each.option === question.recommend)) {
      context.addIssue({ code: 'custom', path: ['recommend'], message: 'recommend must equal one option' });
    }
  });

/** What a planner could not settle from the ticket alone. */
export const Questions = z.object({ questions: z.array(Question) });

/**
 * Whether the ticket earns its place: kept, or canceled as not worth doing, each with how sure the check is; the open
 * tickets it should become one ticket with; and whether the repository already does what the ticket asks (`stale`).
 */
export const Worth = z.object({
  verdict: z.enum(['keep', 'cancel']),
  confidence: z.number().min(0).max(1),
  why: z.string(),
  merges: z.array(z.object({ ticketKey: z.string(), confidence: z.number().min(0).max(1), why: z.string() })),
  stale: z.boolean(),
  staleEvidence: z.string(),
});

export const Findings = z.object({ duplicates: Duplicates, questions: Questions, worth: Worth });

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
  /** `to` must land before this ticket can start: written as `to`'s `blocks` relation, which the watcher waits on. */
  /**
   * `why` is what the comment says beside it: the overlap stage's reason, the files both tickets' plans change. The
   * judge's own carries none.
   */
  z.object({ kind: z.literal('blocked_by'), to: z.string(), why: z.string().optional() }),
  /**
   * The ticket is real work but not the factory's: it needs no code change, needs a measurement or a person's
   * walkthrough, or belongs in another repository. It is labelled `manual` and never planned.
   */
  z.object({ kind: z.literal('manual'), reason: z.string() }),
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
  /**
   * The open questions the judge confirmed, which a person must answer before the ticket is planned: at most two, the
   * ones a person most needs to answer. The judge settles the rest as assumptions.
   */
  questions: z.array(Question).max(2),
});

/**
 * What the planner submits beside plan.md: the plan's structured part, and the open questions it could not settle, at
 * most two. A plan with questions is not attached: the ticket waits for a person's answers and is groomed again.
 */
export const Planned = PlanOutput.extend({ questions: z.array(Question).max(2) });

/**
 * The actions the workflow lets through, the ones it only reports, the questions it posts, the label the groomed ticket
 * ends with, and the plan act attaches: `groomed` for a ticket an action ended, `open-questions` while a person must
 * answer, `manual` for a ticket only a person can do, and `planned` once the plan is written, which puts `factory` on too.
 */
export const Verdict = z.object({
  apply: z.array(Action),
  reported: z.array(z.string()),
  /** The open questions the comment posts: none once an action ended the ticket or ruled it manual. */
  questions: z.array(Question),
  outcome: z.enum(['groomed', 'manual', 'open-questions', 'planned']),
  /** The plan's structured part when the outcome is `planned`, and null otherwise. */
  plan: PlanOutput.nullable(),
});

/**
 * What the overlap stage found for a newly planned ticket: the open planned ticket it must wait on, or null, with the
 * paths both plans name and the reason as the comment words it; every ticket whose plan it compared; and why a ticket
 * was not compared or was passed over.
 */
export const Overlap = z.object({
  blockedBy: z.string().nullable(),
  why: z.string().nullable(),
  shared: z.array(z.string()),
  compared: z.array(z.object({ ticketKey: z.string(), attachedAt: z.string(), shared: z.array(z.string()) })),
  notes: z.array(z.string()),
});

export const Acted = z.object({
  applied: z.array(z.string()),
  reported: z.array(z.string()),
  failed: z.array(z.string()),
  comment: z.string(),
  unlabelled: z.boolean(),
  /** The labels put on: the outcome (`manual` included), and `factory` beside `planned`. */
  labelled: z.array(z.string()),
  /** The attached plan's URL, or null when no plan was attached. */
  attached: z.string().nullable(),
});
