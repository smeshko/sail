// file-follow-ups: files at most two follow-ups as tickets of their own through `sail port ticket-source create`, bugs
// first, and notes the rest; one Jev finds is the same work as an open ticket is commented there instead. Then it lists
// what it did on the pull request. It runs once the pull request is open, so a ticket that can't be filed is reported,
// not fatal. Shared: the factory files what its run found, and review what its judge set aside for a ticket.
import { script, value, z } from 'sail';

/** Work a run found and left for later: filed as a ticket of its own. */
export const FollowUp = z.object({
  title: z.string().max(120),
  description: z.string(),
  type: z.enum(['bug', 'feature', 'refactoring']),
  /** How a person reaches the problem: the command, the input or the code path that triggers it. */
  trigger: z.string().min(1),
  /** True for a review finding: its ticket also gets the `code-review` label. */
  fromReview: z.boolean(),
});

export const FollowUps = z.object({ followUps: z.array(FollowUp) });

/** The pull request the tickets are listed on. */
export const PullRequestRef = z.object({ number: z.number().int(), url: z.string() });

export const Filed = z.object({
  filed: z.array(z.object({ title: z.string(), ticketKey: z.string(), url: z.string() })),
  /** The follow-ups Jev found already open as a ticket, which got a comment instead. */
  existing: z.array(z.object({ title: z.string(), ticketKey: z.string(), confidence: z.number() })),
  /** The follow-ups past the cap: listed on the pull request, not filed. */
  noted: z.array(z.object({ title: z.string() })),
  failed: z.array(z.object({ title: z.string(), error: z.string() })),
  /** Why the duplicate check couldn't run, so every follow-up was filed unchecked. Null when it ran. */
  unchecked: z.string().nullable(),
});

export const fileFollowUps = script('file-follow-ups', {
  run: './run.sh',
  // `origin` ends each ticket's description: "From <origin>: <pull request url>".
  consumes: { followUps: value(FollowUps), pr: value(PullRequestRef), origin: value(z.string()) },
  output: Filed,
  exitCodes: { passed: [0], failed: [] },
});
