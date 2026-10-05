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

/** The moves ADR-0015 names, which each adapter maps to its provider's states. */
export const TicketMove = z.enum(['unstarted', 'in-progress', 'in-review', 'done']);
export type TicketMove = z.infer<typeof TicketMove>;

export const Comment = z.object({ author: z.string(), body: z.string(), createdAt: z.string().optional() });
export type Comment = z.infer<typeof Comment>;

export const Link = z.object({ url: z.string(), title: z.string().optional() });
export type Link = z.infer<typeof Link>;

export const Attachment = z.object({ name: z.string(), url: z.string(), mimeType: z.string().optional() });
export type Attachment = z.infer<typeof Attachment>;

export const Ticket = z.object({
  ticketKey: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string(),
  state: TicketState,
  labels: z.array(z.string()),
  comments: z.array(Comment),
  links: z.array(Link),
  attachments: z.array(Attachment),
  raw: Raw,
});
export type Ticket = z.infer<typeof Ticket>;

// Ticket results

export const ClaimResult = z.object({ claimed: z.boolean(), state: TicketState, raw: Raw });
export type ClaimResult = z.infer<typeof ClaimResult>;

export const Moved = z.object({ state: TicketState, raw: Raw });
export type Moved = z.infer<typeof Moved>;

export const Posted = z.object({ id: z.string(), url: z.string().optional(), raw: Raw });
export type Posted = z.infer<typeof Posted>;

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

// Merges

export const MergeMethod = z.enum(['merge', 'squash', 'rebase']);
export type MergeMethod = z.infer<typeof MergeMethod>;

/** A merge counts once the host reports it (D4): `pending` and `refused` say why it hasn't happened. */
export const MergeResult = z.discriminatedUnion('state', [
  z.object({ state: z.literal('merged'), sha: z.string(), raw: Raw }),
  z.object({ state: z.literal('pending'), reason: z.string().min(1), raw: Raw }),
  z.object({ state: z.literal('refused'), reason: z.string().min(1), raw: Raw }),
]);
export type MergeResult = z.infer<typeof MergeResult>;

// Leases

/** The run taking a lease. `pid` names a process: 0 and below would signal a process group, which always reads alive. */
export const LeaseHolder = z.object({ runId: z.string().min(1), runDir: z.string(), pid: z.number().int().positive() });
export type LeaseHolder = z.infer<typeof LeaseHolder>;

export const Lease = LeaseHolder.extend({ remote: z.string(), branch: z.string(), takenAt: z.string() });
export type Lease = z.infer<typeof Lease>;

/** A lease taken, `took` naming the stale run it replaced, or refused, naming who holds it. */
export const LeaseResult = z.discriminatedUnion('leased', [
  z.object({ leased: z.literal(true), lease: Lease, took: z.string().optional(), raw: Raw }),
  z.object({ leased: z.literal(false), holder: Lease, raw: Raw }),
]);
export type LeaseResult = z.infer<typeof LeaseResult>;

export const Released = z.object({ released: z.boolean(), raw: Raw });
export type Released = z.infer<typeof Released>;

// Workspaces

export const Workspace = z.object({ path: z.string(), branch: z.string(), baseSha: z.string(), raw: Raw });
export type Workspace = z.infer<typeof Workspace>;

export const Diff = z.object({ patch: z.string(), raw: Raw });
export type Diff = z.infer<typeof Diff>;

export const WorkspaceReleased = z.object({ path: z.string(), kept: z.boolean(), raw: Raw });
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
export const HarnessFailure = z.enum(['harness', 'budget_exceeded', 'timeout']);
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
