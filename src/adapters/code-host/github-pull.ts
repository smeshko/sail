// GitHub's pull request in the port's words, and the hidden marker that keeps a pull request's ticket key in its body
// (DECISIONS D9): GitHub has no field for it, and a later read must give it back.
//
// A stub until TASK-004: the marker is neither written nor read, and a pull request maps to an empty one.
import type { PullRequest } from '../../ports/types';

/** The fields of GitHub's pull request the adapter reads. */
export interface GitHubPull {
  readonly number: number;
  readonly html_url: string;
  readonly title: string;
  readonly state: string;
  readonly merged_at?: string | null;
  readonly draft?: boolean | null;
  readonly body?: string | null;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string };
  readonly labels?: readonly { readonly name: string }[];
}

/** `body` with the ticket marker on a line of its own after it, or `body` as it is without a key. */
export function withTicketMarker(body: string, _ticketKey: string | undefined): string {
  return body;
}

/** The ticket key of the body's last marker, or undefined when it has none. */
export function ticketKeyOf(_body: string | null | undefined): string | undefined {
  return undefined;
}

export function toPullRequest(_node: GitHubPull): PullRequest {
  return {
    number: 0,
    url: '',
    title: '',
    base: '',
    head: '',
    headSha: '',
    draft: false,
    state: 'open',
    labels: [],
    raw: {},
  };
}
