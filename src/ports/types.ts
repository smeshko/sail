// The shapes every port speaks, as Zod schemas with their inferred types under the same names. What an adapter returns
// crosses a trust boundary, since a repository's own adapter is untrusted code, so it is parsed there. Every provider
// result carries `raw`, the provider's own answer.
import { z } from 'zod';

export type { Budget, Permissions } from '../sdk/steps';

/** The provider's own answer. Required: `undefined` is rejected, `null` is not. */
export const Raw = z.unknown().refine((value) => value !== undefined, { message: 'raw is required' });
export type Raw = z.infer<typeof Raw>;

// Tickets

export const TicketStateType = z.enum(['unstarted', 'started', 'completed', 'canceled']);
export type TicketStateType = z.infer<typeof TicketStateType>;

/** A ticket's state by type, with the provider's own name for it, such as "In Review". */
export const TicketState = z.object({ type: TicketStateType, name: z.string() });
export type TicketState = z.infer<typeof TicketState>;

/** The moves ADR-0015 names, and `canceled` for a ticket groomed away, which each adapter maps to its provider's states. */
export const TicketMove = z.enum(['unstarted', 'in-progress', 'in-review', 'done', 'canceled']);
export type TicketMove = z.infer<typeof TicketMove>;

export const Comment = z.object({ author: z.string(), body: z.string(), createdAt: z.string().optional() });
export type Comment = z.infer<typeof Comment>;

export const Link = z.object({ url: z.string(), title: z.string().optional() });
export type Link = z.infer<typeof Link>;

export const Attachment = z.object({ name: z.string(), url: z.string(), mimeType: z.string().optional() });
export type Attachment = z.infer<typeof Attachment>;

export const TicketPriority = z.enum(['urgent', 'high', 'medium', 'low', 'none']);
export type TicketPriority = z.infer<typeof TicketPriority>;

export const Ticket = z.object({
  ticketKey: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string(),
  state: TicketState,
  priority: TicketPriority.optional(),
  labels: z.array(z.string()),
  comments: z.array(Comment),
  links: z.array(Link),
  attachments: z.array(Attachment),
  raw: Raw,
});
export type Ticket = z.infer<typeof Ticket>;

/** A ticket as `list` reads it: what grooming surveys, without its comments, links and attachments. */
export const ListedTicket = Ticket.pick({
  ticketKey: true,
  title: true,
  url: true,
  description: true,
  state: true,
  labels: true,
}).extend({ raw: Raw });
export type ListedTicket = z.infer<typeof ListedTicket>;

// Ticket results

export const ClaimResult = z.object({ claimed: z.boolean(), state: TicketState, raw: Raw });
export type ClaimResult = z.infer<typeof ClaimResult>;

export const Moved = z.object({ state: TicketState, raw: Raw });
export type Moved = z.infer<typeof Moved>;

export const Posted = z.object({ id: z.string(), url: z.string().optional(), raw: Raw });
export type Posted = z.infer<typeof Posted>;

/** A ticket `create` filed: its ticket key and URL. */
export const Created = z.object({ ticketKey: z.string(), url: z.string(), raw: Raw });
export type Created = z.infer<typeof Created>;

/** What `addLabel` and `removeLabel` leave: the labels the ticket carries afterwards. */
export const Relabelled = z.object({ ticketKey: z.string(), labels: z.array(z.string()), raw: Raw });
export type Relabelled = z.infer<typeof Relabelled>;

/** How `relate` ties a ticket to another: `blocks` and `duplicate` read from the ticket the call names. */
export const TicketRelation = z.enum(['related', 'blocks', 'duplicate']);
export type TicketRelation = z.infer<typeof TicketRelation>;

/** What `relate` leaves: the relation made, and the state the ticket is in then. */
export const Related = z.object({
  ticketKey: z.string(),
  kind: TicketRelation,
  to: z.string(),
  state: TicketState,
  raw: Raw,
});
export type Related = z.infer<typeof Related>;

/** What `edit` leaves: the ticket's key and URL. */
export const Edited = z.object({ ticketKey: z.string(), url: z.string(), raw: Raw });
export type Edited = z.infer<typeof Edited>;

/** A file `attach` attached to a ticket: the attachment's URL. */
export const Attached = z.object({ url: z.string(), raw: Raw });
export type Attached = z.infer<typeof Attached>;

// Pull requests

export const PullRequest = z.object({
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  base: z.string(),
  head: z.string(),
  headSha: z.string(),
  draft: z.boolean(),
  state: z.enum(['open', 'closed', 'merged']),
  labels: z.array(z.string()),
  ticketKey: z.string().optional(),
  raw: Raw,
});
export type PullRequest = z.infer<typeof PullRequest>;

/**
 * A pull request as `getPullRequest` reads it: `PullRequest` with its body (`''` when the host has none), its author's
 * login, the base commit the host records for it, whether its head branch lives outside the repository, and its
 * conversation comments, oldest first.
 */
export const PullRequestDetails = PullRequest.extend({
  body: z.string(),
  author: z.string(),
  baseSha: z.string(),
  fork: z.boolean(),
  comments: z.array(Comment),
});
export type PullRequestDetails = z.infer<typeof PullRequestDetails>;

export const Pushed = z.object({ branch: z.string(), headSha: z.string(), raw: Raw });
export type Pushed = z.infer<typeof Pushed>;

export const Labelled = z.object({ number: z.number().int(), labels: z.array(z.string()), raw: Raw });
export type Labelled = z.infer<typeof Labelled>;

// Checks

export const CheckStatus = z.enum(['pending', 'passed', 'failed', 'skipped']);
export type CheckStatus = z.infer<typeof CheckStatus>;

export const Check = z.object({ name: z.string(), status: CheckStatus, url: z.string().optional() });
export type Check = z.infer<typeof Check>;

export const Checks = z.object({ number: z.number().int(), headSha: z.string(), checks: z.array(Check), raw: Raw });
export type Checks = z.infer<typeof Checks>;

/** The checks `rerunChecks` ran again, by name: none when nothing had failed or nothing could be rerun. */
export const Rerun = z.object({
  number: z.number().int(),
  headSha: z.string(),
  rerun: z.array(z.string()),
  raw: Raw,
});
export type Rerun = z.infer<typeof Rerun>;

/** How many characters of a check's log `checkLog` answers: the last of them. */
export const CHECK_LOG_TAIL = 20_000;

/** The tail of one check's log. */
export const CheckLog = z.object({
  number: z.number().int(),
  name: z.string(),
  log: z.string(),
  url: z.string().optional(),
  raw: Raw,
});
export type CheckLog = z.infer<typeof CheckLog>;

// Merges

export const MergeMethod = z.enum(['merge', 'squash', 'rebase']);
export type MergeMethod = z.infer<typeof MergeMethod>;

/**
 * What a merge asks for: the method, and the expected head, the head sha the workflow checked. The host merges only
 * while the pull request is still at it (DECISIONS D1).
 */
export const MergeRequest = z.object({
  method: MergeMethod,
  expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character hex sha'),
});
export type MergeRequest = z.infer<typeof MergeRequest>;

/** Why `request` is no MergeRequest: a method that isn't one, or an expected head that is no sha. */
export function mergeRequestIssue(request: unknown): string {
  const { method, expectedHeadSha } = (request ?? {}) as { method?: unknown; expectedHeadSha?: unknown };
  if (!MergeMethod.safeParse(method).success) return `${String(method)} is not a merge method`;
  return `expectedHeadSha ${JSON.stringify(expectedHeadSha) ?? 'undefined'} is not a 40-character hex sha`;
}

/** A merge counts once the host reports it (D4): `pending` and `refused` say why it hasn't happened. */
export const MergeResult = z.discriminatedUnion('state', [
  z.object({ state: z.literal('merged'), sha: z.string(), raw: Raw }),
  z.object({ state: z.literal('pending'), reason: z.string().min(1), raw: Raw }),
  z.object({ state: z.literal('refused'), reason: z.string().min(1), raw: Raw }),
]);
export type MergeResult = z.infer<typeof MergeResult>;

// Leases

/** The run taking a lease. `pid` names a process: 0 and below would signal a process group, which always reads alive. */
export const LeaseHolder = z.object({
  runId: z.string().min(1),
  runDir: z.string(),
  pid: z.number().int().positive(),
  /** Written by a run as it suspends: no process holds the lease, whatever its pid. */
  suspended: z.literal(true).optional(),
});
export type LeaseHolder = z.infer<typeof LeaseHolder>;

export const Lease = LeaseHolder.extend({ remote: z.string(), branch: z.string(), takenAt: z.string() });
export type Lease = z.infer<typeof Lease>;

/** A lease taken, `took` naming the stale run it replaced, or refused, naming who holds it. */
export const LeaseResult = z.discriminatedUnion('leased', [
  z.object({ leased: z.literal(true), lease: Lease, took: z.string().optional(), raw: Raw }),
  z.object({ leased: z.literal(false), holder: Lease, file: z.string().optional(), raw: Raw }),
]);
export type LeaseResult = z.infer<typeof LeaseResult>;

export const Released = z.object({ released: z.boolean(), raw: Raw });
export type Released = z.infer<typeof Released>;

// Workspaces

export const Workspace = z.object({ path: z.string(), branch: z.string(), baseSha: z.string(), raw: Raw });
export type Workspace = z.infer<typeof Workspace>;

/** The repository a Workspace adapter works for: `url` keys its leases, and a run starts from `defaultBranch`. */
export const Repository = z.object({ url: z.string().min(1), defaultBranch: z.string().min(1), raw: Raw });
export type Repository = z.infer<typeof Repository>;

export const Diff = z.object({ patch: z.string(), raw: Raw });
export type Diff = z.infer<typeof Diff>;

/** `ref` is where a removed workspace's commits are kept, at `head`, when its `HEAD` had moved past its base. */
export const WorkspaceReleased = z.object({
  path: z.string(),
  kept: z.boolean(),
  ref: z.string().optional(),
  head: z.string().optional(),
  raw: Raw,
});
export type WorkspaceReleased = z.infer<typeof WorkspaceReleased>;

export const Swept = z.object({ paths: z.array(z.string()), raw: Raw });
export type Swept = z.infer<typeof Swept>;

// Harness

const count = z.number().int().nonnegative().optional();

/** Tokens and cost, as `sail.result.v1#/$defs/usage` records them: whole, non-negative counts, and dollars of 0 or more. */
export const Usage = z.object({
  inputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  outputTokens: count,
  costUsd: z.number().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

const session = { sessionId: z.string(), usage: Usage, transcript: z.string(), raw: Raw };

/** Why a session ended in `error`. Left out, it is `harness`. */
export const HarnessFailure = z.enum(['harness', 'budget_exceeded', 'timeout', 'usage_limit']);
export type HarnessFailure = z.infer<typeof HarnessFailure>;

/** A blocked reason says something: whitespace alone is no reason. */
const reason = z.string().refine((text) => text.trim() !== '', { message: 'a reason is required' });

/** How an agent step's session ended: its submitted output, a blocked reason, or an error's message. */
export const HarnessResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('done'), output: z.unknown(), ...session }),
  z.object({ outcome: z.literal('blocked'), reason, ...session }),
  z.object({
    outcome: z.literal('error'),
    message: z.string().min(1),
    reason: HarnessFailure.optional(),
    /** When a `usage_limit` resets, if the provider said. */
    resetsAt: z.iso.datetime().optional(),
    ...session,
  }),
]);
export type HarnessResult = z.infer<typeof HarnessResult>;

// Capabilities (D13)

export const TicketSourceCapabilities = z.object({
  comments: z.boolean(),
  links: z.boolean(),
  attachments: z.boolean(),
  moves: z.array(TicketMove),
});
export type TicketSourceCapabilities = z.infer<typeof TicketSourceCapabilities>;

export const CodeHostCapabilities = z.object({
  checks: z.boolean(),
  labels: z.boolean(),
  drafts: z.boolean(),
  mergeMethods: z.array(MergeMethod),
});
export type CodeHostCapabilities = z.infer<typeof CodeHostCapabilities>;

export const HarnessCapabilities = z.object({
  structuredOutput: z.boolean(),
  permissions: z.boolean(),
  usage: z.boolean(),
  abort: z.boolean(),
  budgets: z.array(z.enum(['turns', 'usd', 'minutes'])),
});
export type HarnessCapabilities = z.infer<typeof HarnessCapabilities>;

export const WorkspaceCapabilities = z.object({ keep: z.boolean(), sweep: z.boolean() });
export type WorkspaceCapabilities = z.infer<typeof WorkspaceCapabilities>;

// Jev

/** What Jev reports as a probability: one number per option or level, keyed by its name or in the order asked. */
const JevProbabilities = z.union([z.record(z.string(), z.number()), z.array(z.number())]);

/** A question about a state: its question type, its instructions and the criteria its answer is chosen among. */
export const JevQuestion = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    instructions: z.string(),
    criteria: z
      .record(z.string(), z.string())
      .refine((options) => Object.keys(options).length >= 1 && Object.keys(options).length <= 255, {
        message: 'needs 1 to 255 options',
      }),
  }),
  z.object({
    type: z.literal('score'),
    instructions: z.string(),
    criteria: z.array(z.string()).min(1).max(10),
  }),
  z.object({
    type: z.literal('noul'),
    instructions: z.string(),
    criteria: z.object({ true: z.string(), false: z.string() }),
  }),
]);
export type JevQuestion = z.infer<typeof JevQuestion>;

export const JevRequest = z.object({
  state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  questions: z
    .record(z.string(), JevQuestion)
    .refine((questions) => Object.keys(questions).length >= 1, { message: 'needs at least one question' }),
  model: z.string().min(1).optional(),
});
export type JevRequest = z.infer<typeof JevRequest>;

/** Jev's reply to one question. Confidence and probabilities are kept where Jev reports them. */
export const JevAnswer = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number().optional(),
    probabilities: JevProbabilities.optional(),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    confidence: z.number().optional(),
    probabilities: JevProbabilities.optional(),
    legend: z.unknown().optional(),
  }),
  z.object({ type: z.literal('noul'), noul: z.number() }),
]);
export type JevAnswer = z.infer<typeof JevAnswer>;

export const JevUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type JevUsage = z.infer<typeof JevUsage>;

export const JevAnswered = z.object({
  model: z.string(),
  answers: z.record(z.string(), JevAnswer),
  usage: JevUsage.optional(),
  latencyMs: z.number().nonnegative(),
});
export type JevAnswered = z.infer<typeof JevAnswered>;

export const JevCapabilities = z.object({ questionTypes: z.array(z.enum(['choice', 'score', 'noul'])) });
export type JevCapabilities = z.infer<typeof JevCapabilities>;
