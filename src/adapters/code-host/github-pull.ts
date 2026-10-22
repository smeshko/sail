// GitHub's pull request in the port's words, and the hidden marker that keeps a pull request's ticket key in its body
// (DECISIONS D9): GitHub has no field for it, and a later read must give it back.
import { PortError } from '../../ports/errors';
import type { PullRequest, PullRequestDetails } from '../../ports/types';

/** The fields of GitHub's pull request the adapter reads. */
export interface GitHubPull {
  readonly number: number;
  readonly html_url: string;
  readonly title: string;
  readonly state: string;
  readonly merged_at?: string | null;
  readonly merge_commit_sha?: string | null;
  readonly draft?: boolean | null;
  readonly body?: string | null;
  /** Null for a fork that was deleted: GitHub keeps no repository for its head. */
  readonly head: { readonly ref: string; readonly sha: string; readonly repo?: { readonly full_name: string } | null };
  readonly base: { readonly ref: string; readonly sha?: string };
  readonly labels?: readonly { readonly name: string }[];
  readonly user?: { readonly login: string } | null;
}

/** The fields of a conversation comment the adapter reads. */
export interface GitHubComment {
  readonly id: number;
  readonly body?: string | null;
  readonly user?: { readonly login: string } | null;
  readonly created_at?: string;
}

/** Whether the pull request's head lives outside `repository` (`owner/name`): a deleted fork's head has no repository. */
export function isFork(node: GitHubPull, repository: string): boolean {
  const name = node.head.repo?.full_name;
  return name === undefined || name.toLowerCase() !== repository.toLowerCase();
}

/** A ticket key the marker can hold: nothing that could close the comment. */
const KEY = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/;

const MARKER = /<!-- sail:ticket ([A-Za-z][A-Za-z0-9_]*-[0-9]+) -->/g;

/** `body` with the ticket marker on a line of its own after it, or `body` as it is without a key. */
export function withTicketMarker(body: string, ticketKey: string | undefined): string {
  if (ticketKey === undefined) return body;
  if (!KEY.test(ticketKey)) {
    throw new PortError('codeHost', 'openPullRequest', 'invalid', `${JSON.stringify(ticketKey)} is not a ticket key`);
  }
  return `${body}\n\n<!-- sail:ticket ${ticketKey} -->`;
}

/** The ticket key of the body's last marker, or undefined when it has none. */
export function ticketKeyOf(body: string | null | undefined): string | undefined {
  return [...(body ?? '').matchAll(MARKER)].at(-1)?.[1];
}

export function toPullRequest(node: GitHubPull): PullRequest {
  const ticketKey = ticketKeyOf(node.body);
  return {
    number: node.number,
    url: node.html_url,
    title: node.title,
    base: node.base.ref,
    head: node.head.ref,
    headSha: node.head.sha,
    draft: node.draft === true,
    state: node.merged_at ? 'merged' : node.state === 'open' ? 'open' : 'closed',
    labels: (node.labels ?? []).map((label) => label.name),
    ...(ticketKey === undefined ? {} : { ticketKey }),
    raw: node,
  };
}

/** The pull request with its details: its body, author, base sha, whether it is a fork, and its comments in order. */
export function toPullRequestDetails(
  node: GitHubPull,
  comments: readonly GitHubComment[],
  repository: string,
): PullRequestDetails {
  return {
    ...toPullRequest(node),
    body: node.body ?? '',
    author: node.user?.login ?? '',
    baseSha: node.base.sha ?? '',
    fork: isFork(node, repository),
    comments: comments.map((comment) => ({
      author: comment.user?.login ?? '',
      body: comment.body ?? '',
      ...(comment.created_at === undefined ? {} : { createdAt: comment.created_at }),
    })),
    raw: { pull: node, comments },
  };
}
