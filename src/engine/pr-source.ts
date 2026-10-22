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
import { PortError } from '../ports/errors';
import type { TicketSource } from '../ports/ticket-source';
import { PullRequestDetails } from '../ports/types';
import type { Forced } from './run-dir';

/** What a ref names: a ticket of the TicketSource, a pull request of the CodeHost, or a refusal. */
export type ResolvedRef = { kind: 'ticket'; ticketKey: string } | { kind: 'pr'; number: number } | { refused: string };

/** Why `ref` names nothing either adapter reads. */
export function neitherRef(ref: string, ticketSource: TicketSource, codeHost: CodeHost): string {
  return `'${ref}' is neither a ticket of the ${ticketSource.name} ticket source (a ticket key, or a URL it owns) nor a pull request of the ${codeHost.name} code host (#<number>, or its URL)`;
}

/** What `ref` names, read by both adapters: one reading is the source, two or none are refused. */
export function resolveRef(ref: string, ticketSource: TicketSource, codeHost: CodeHost): ResolvedRef {
  const ticketKey = ticketSource.parseKey(ref);
  const number = codeHost.parseRef(ref);
  if (ticketKey !== undefined && number !== undefined) {
    return {
      refused: `'${ref}' reads as ticket ${ticketKey} on the ${ticketSource.name} ticket source and as pull request #${number} on the ${codeHost.name} code host: name it as a ticket key, or as #${number} or its URL`,
    };
  }
  if (ticketKey !== undefined) return { kind: 'ticket', ticketKey };
  if (number !== undefined) return { kind: 'pr', number };
  return { refused: neitherRef(ref, ticketSource, codeHost) };
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

/** The pull request `number`, as `getPullRequest` answers it: an answer that is no PullRequestDetails is `invalid`. */
export async function getPullRequestDetails(codeHost: CodeHost, number: number): Promise<PullRequestDetails> {
  const answer: unknown = await codeHost.getPullRequest(number);
  const parsed = PullRequestDetails.safeParse(answer);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const where = [issue?.path.join('.'), issue?.message].filter(Boolean).join(' ');
  throw new PortError(
    'codeHost',
    'getPullRequest',
    'invalid',
    `#${number} is not a PullRequestDetails: ${where}`,
    answer,
  );
}

/** Whether `head` is the branch of ticket `key`: `<prefix><KEY>`, or `<prefix><KEY>-` and a slug. */
export function isTicketBranch(head: string, prefix: string, key: string): boolean {
  const branch = `${prefix}${key}`;
  return head === branch || head.startsWith(`${branch}-`);
}

/**
 * The ticket key the pull request's marker names, when its head branch is that ticket's: undefined with no marker, and
 * a refusal when the marker names a ticket the branch isn't (D2).
 */
export function markerKey(pr: PullRequestDetails, branchPrefix: string): { ticketKey?: string } | { refused: string } {
  const key = pr.ticketKey;
  if (key === undefined) return {};
  if (isTicketBranch(pr.head, branchPrefix, key)) return { ticketKey: key };
  return {
    refused: `pull request #${pr.number}'s ticket marker names ${key}, but its head branch ${pr.head} is not ${key}'s: fix or remove the marker`,
  };
}

// Every refusal a pull request earns, in one place. Each says what `--force` would do about it.
const FORCE = '--force runs it anyway';
const NO_FORCE = "--force doesn't change that";

/** A port's failure as a refusal: its own message, with its code. Anything else is a bug in sail, and is thrown on. */
function refusalOf(error: unknown): string {
  if (!(error instanceof PortError)) throw error;
  return `${error.message} (${error.code})`;
}

/** The pull request `number`, fetched and checked. Nothing is written to it. */
export async function resolvePullRequest(
  options: ResolvePullRequestOptions,
): Promise<ResolvedPullRequest | { refused: string }> {
  const { number, codeHost, label, branchPrefix, defaultBranch, force = false, headSha } = options;
  let pr: PullRequestDetails;
  try {
    pr = await getPullRequestDetails(codeHost, number);
  } catch (error) {
    return { refused: refusalOf(error) };
  }
  // Never forced, so first: --force must never hide them.
  if (pr.fork) {
    return {
      refused: `pull request #${number} comes from a fork: its head ${pr.head} is not a branch of this repository. ${NO_FORCE}`,
    };
  }
  if (pr.head === defaultBranch) {
    return {
      refused: `pull request #${number}'s head is ${pr.head}, the default branch, which no run may lease. ${NO_FORCE}`,
    };
  }
  const marker = markerKey(pr, branchPrefix);
  if ('refused' in marker) return { refused: `${marker.refused}. ${NO_FORCE}` };
  if (headSha !== undefined && pr.headSha !== headSha) {
    return { refused: `pull request #${number}'s head is now ${pr.headSha.slice(0, 7)}, not ${headSha.slice(0, 7)}` };
  }
  const unready = pr.state !== 'open' ? `is ${pr.state}` : pr.draft ? 'is a draft' : undefined;
  const designated = pr.labels.includes(label);
  if (!force) {
    if (unready !== undefined) return { refused: `pull request #${number} ${unready}. ${FORCE}` };
    if (!designated) {
      return { refused: `pull request #${number} is not designated: it carries no '${label}' label. ${FORCE}` };
    }
  }
  const forced: Forced[] = [
    ...(designated ? [] : (['designation'] as const)),
    ...(unready ? (['state'] as const) : []),
  ];
  return { pr, ...(marker.ticketKey === undefined ? {} : { ticketKey: marker.ticketKey }), forced };
}
