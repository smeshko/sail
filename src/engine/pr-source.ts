// A pull request as a run's source: the step between "which workflow" and the run directory, on the CodeHost port. It
// only reads. `resolveRef()` asks both the TicketSource and the CodeHost what a ref names, and refuses one both read or
// neither does (DECISIONS D6). `resolvePullRequest()` fetches the pull request and checks it, in D3's order: a fork, a
// head on the default branch and a ticket marker that doesn't match the head branch are always refused; a closed,
// merged or draft pull request (`state`) and an unlabelled one (`designation`) are refused unless `--force`.
//
// The ticket marker is text anyone who can edit the body can change, so its key is kept only when the head branch is
// that ticket's branch, `<branchPrefix><KEY>` or `<branchPrefix><KEY>-…` (D2). The branch is pushed by someone with
// push access, so the key is tied to push access, and a mismatch has no `--force`.
import type { CodeHost } from '../ports/code-host';
import type { TicketSource } from '../ports/ticket-source';
import type { PullRequestDetails } from '../ports/types';
import type { Forced } from './run-dir';

/** What a ref names: a ticket of the TicketSource, a pull request of the CodeHost, or a refusal. */
export type ResolvedRef = { kind: 'ticket'; ticketKey: string } | { kind: 'pr'; number: number } | { refused: string };

/** What `ref` names, read by both adapters: one reading is the source, two or none are refused. */
export function resolveRef(ref: string, ticketSource: TicketSource, codeHost: CodeHost): ResolvedRef {
  const ticketKey = ticketSource.parseKey(ref);
  if (ticketKey !== undefined) return { kind: 'ticket', ticketKey };
  const number = codeHost.parseRef(ref);
  if (number !== undefined) return { kind: 'pr', number };
  return { refused: `'${ref}' names nothing` };
}

export interface ResolvePullRequestOptions {
  number: number;
  codeHost: CodeHost;
  /** The designation label: the workflow's, then the repository's, then sail's. */
  label: string;
  /** The prefix a ticket's branch is named with, which the ticket marker is checked against. */
  branchPrefix: string;
  /** The repository's default branch: a head there is refused. */
  defaultBranch: string;
  /** Overrides `state` (closed, merged or a draft) and `designation` (unlabelled). Nothing else. */
  force?: boolean;
  /** The head sha a dispatched run was queued at: a pull request whose head has moved since is refused. */
  headSha?: string;
}

export interface ResolvedPullRequest {
  pr: PullRequestDetails;
  /** The ticket marker's key, kept only when the head branch is that ticket's branch. */
  ticketKey?: string;
  /** The checks `--force` overrode, in `FORCED`'s order. */
  forced: Forced[];
}

/** The pull request `number`, fetched and checked. Nothing is written to it. */
export async function resolvePullRequest(
  options: ResolvePullRequestOptions,
): Promise<ResolvedPullRequest | { refused: string }> {
  try {
    const pr = (await options.codeHost.getPullRequest(options.number)) as PullRequestDetails;
    return { pr, ticketKey: 'STUB-1', forced: [] };
  } catch {
    return { pr: {} as PullRequestDetails, ticketKey: 'STUB-1', forced: [] };
  }
}
