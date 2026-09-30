// The shapes every port speaks, as Zod schemas with their inferred types under the same names. What an adapter returns
// crosses a trust boundary, since a repository's own adapter is untrusted code, so it is parsed there. Every provider
// result carries `raw`, the provider's own answer.
// STUB (TASK-002): each schema is `pending()`, typed as it will be and rejecting every value. TASK-002 writes them.
import { z } from 'zod';

export type { Budget, Permissions } from '../sdk/steps';

/** Stands in for a schema TASK-002 writes: its type is final, and it rejects every value. */
function pending<T>(): z.ZodType<T> {
  return z.never() as unknown as z.ZodType<T>;
}

/** The provider's own answer. Required: `undefined` is rejected, `null` is not. */
export const Raw = pending<unknown>();
export type Raw = z.infer<typeof Raw>;

// Tickets

export const TicketStateType = pending<'unstarted' | 'started' | 'completed' | 'canceled'>();
export type TicketStateType = z.infer<typeof TicketStateType>;

/** A ticket's state by type, with the provider's own name for it, such as "In Review". */
export const TicketState = pending<{ type: TicketStateType; name: string }>();
export type TicketState = z.infer<typeof TicketState>;

/** The moves ADR-0015 names, which each adapter maps to its provider's states. */
export const TicketMove = pending<'unstarted' | 'in-progress' | 'in-review' | 'done'>();
export type TicketMove = z.infer<typeof TicketMove>;

export const Comment = pending<{ author: string; body: string; createdAt?: string }>();
export type Comment = z.infer<typeof Comment>;

export const Link = pending<{ url: string; title?: string }>();
export type Link = z.infer<typeof Link>;

export const Attachment = pending<{ name: string; url: string; mimeType?: string }>();
export type Attachment = z.infer<typeof Attachment>;

export const Ticket = pending<{
  ticketKey: string;
  title: string;
  url: string;
  description: string;
  state: TicketState;
  labels: string[];
  comments: Comment[];
  links: Link[];
  attachments: Attachment[];
  raw: Raw;
}>();
export type Ticket = z.infer<typeof Ticket>;

// Ticket results

export const ClaimResult = pending<{ claimed: boolean; state: TicketState; raw: Raw }>();
export type ClaimResult = z.infer<typeof ClaimResult>;

export const Moved = pending<{ state: TicketState; raw: Raw }>();
export type Moved = z.infer<typeof Moved>;

export const Posted = pending<{ id: string; url?: string; raw: Raw }>();
export type Posted = z.infer<typeof Posted>;

// Pull requests

export const PullRequest = pending<{
  number: number;
  url: string;
  title: string;
  base: string;
  head: string;
  headSha: string;
  draft: boolean;
  state: 'open' | 'closed' | 'merged';
  labels: string[];
  ticketKey?: string;
  raw: Raw;
}>();
export type PullRequest = z.infer<typeof PullRequest>;

export const Pushed = pending<{ branch: string; headSha: string; raw: Raw }>();
export type Pushed = z.infer<typeof Pushed>;

export const Labelled = pending<{ number: number; labels: string[]; raw: Raw }>();
export type Labelled = z.infer<typeof Labelled>;

// Checks

export const CheckStatus = pending<'pending' | 'passed' | 'failed' | 'skipped'>();
export type CheckStatus = z.infer<typeof CheckStatus>;

export const Check = pending<{ name: string; status: CheckStatus; url?: string }>();
export type Check = z.infer<typeof Check>;

export const Checks = pending<{ number: number; headSha: string; checks: Check[]; raw: Raw }>();
export type Checks = z.infer<typeof Checks>;

// Merges

export const MergeMethod = pending<'merge' | 'squash' | 'rebase'>();
export type MergeMethod = z.infer<typeof MergeMethod>;

/** A merge counts once the host reports it (D4): `pending` and `refused` say why it hasn't happened. */
export const MergeResult = pending<
  | { state: 'merged'; sha: string; raw: Raw }
  | { state: 'pending'; reason: string; raw: Raw }
  | { state: 'refused'; reason: string; raw: Raw }
>();
export type MergeResult = z.infer<typeof MergeResult>;

// Leases

export const LeaseHolder = pending<{ runId: string; runDir: string; pid: number }>();
export type LeaseHolder = z.infer<typeof LeaseHolder>;

export const Lease = pending<LeaseHolder & { remote: string; branch: string; takenAt: string }>();
export type Lease = z.infer<typeof Lease>;

/** A lease taken, `took` naming the stale run it replaced, or refused, naming who holds it. */
export const LeaseResult = pending<
  { leased: true; lease: Lease; took?: string; raw: Raw } | { leased: false; holder: Lease; raw: Raw }
>();
export type LeaseResult = z.infer<typeof LeaseResult>;

export const Released = pending<{ released: boolean; raw: Raw }>();
export type Released = z.infer<typeof Released>;

// Workspaces

export const Workspace = pending<{ path: string; branch: string; baseSha: string; raw: Raw }>();
export type Workspace = z.infer<typeof Workspace>;

export const Diff = pending<{ patch: string; raw: Raw }>();
export type Diff = z.infer<typeof Diff>;

export const WorkspaceReleased = pending<{ path: string; kept: boolean; raw: Raw }>();
export type WorkspaceReleased = z.infer<typeof WorkspaceReleased>;

export const Swept = pending<{ paths: string[]; raw: Raw }>();
export type Swept = z.infer<typeof Swept>;

// Harness

/** Tokens and cost, as `sail.result.v1#/$defs/usage` records them: whole, non-negative counts. */
export const Usage = pending<{
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  costUsd: number;
}>();
export type Usage = z.infer<typeof Usage>;

interface Session {
  sessionId: string;
  usage: Usage;
  transcript: string;
  raw: Raw;
}

/** How an agent step's session ended: its submitted output, a blocked reason, or an error's message. */
export const HarnessResult = pending<
  | (Session & { outcome: 'done'; output: unknown })
  | (Session & { outcome: 'blocked'; reason: string })
  | (Session & { outcome: 'error'; message: string })
>();
export type HarnessResult = z.infer<typeof HarnessResult>;

// Capabilities (D13)

export const TicketSourceCapabilities = pending<{
  comments: boolean;
  links: boolean;
  attachments: boolean;
  moves: TicketMove[];
}>();
export type TicketSourceCapabilities = z.infer<typeof TicketSourceCapabilities>;

export const CodeHostCapabilities = pending<{
  checks: boolean;
  labels: boolean;
  drafts: boolean;
  mergeMethods: MergeMethod[];
}>();
export type CodeHostCapabilities = z.infer<typeof CodeHostCapabilities>;

export const HarnessCapabilities = pending<{
  structuredOutput: boolean;
  permissions: boolean;
  usage: boolean;
  abort: boolean;
  budgets: ('turns' | 'usd' | 'minutes')[];
}>();
export type HarnessCapabilities = z.infer<typeof HarnessCapabilities>;

export const WorkspaceCapabilities = pending<{ keep: boolean; sweep: boolean }>();
export type WorkspaceCapabilities = z.infer<typeof WorkspaceCapabilities>;
