// Linear's answers as sail's Ticket, and Linear's state types as sail's. Free of I/O, so its mapping takes plain values.
import { PortError } from '../../../ports/errors';
import type { Ticket, TicketStateType } from '../../../ports/types';
import { clean } from './client';
import type { CommentNode, IssueNode } from './queries';

/** Linear's state types, each as the sail state type it folds onto. `triage` and any other type are not in it. */
const STATE_TYPES: ReadonlyMap<string, TicketStateType> = new Map([
  ['backlog', 'unstarted'],
  ['unstarted', 'unstarted'],
  ['started', 'started'],
  ['completed', 'completed'],
  ['canceled', 'canceled'],
  ['duplicate', 'canceled'],
]);

/**
 * sail's state type for a Linear state type: backlog and unstarted are unstarted, started is started, completed is
 * completed, canceled and duplicate are canceled. Any other type, triage included, is refused with a PortError `invalid`
 * that names it.
 */
export function stateTypeOf(linearType: string, op = 'get'): TicketStateType {
  const mapped = STATE_TYPES.get(linearType);
  if (mapped === undefined) {
    // The type is Linear's text, so it is cleaned before a person reads it (review #2.2).
    throw new PortError(
      'ticketSource',
      op,
      'invalid',
      `Linear state type ${clean(String(linearType))} is not one sail maps`,
    );
  }
  return mapped;
}

/** A Linear issue as a Ticket, with `comments` (every page of them) and `raw` the node as FetchIssue answered it. */
export function toTicket(node: IssueNode, comments: readonly CommentNode[] = node.comments.nodes): Ticket {
  return {
    ticketKey: node.identifier,
    title: node.title,
    url: node.url,
    description: node.description ?? '',
    state: { type: stateTypeOf(node.state.type), name: node.state.name },
    labels: node.labels.nodes.map((label) => label.name),
    comments: comments.map((comment) => ({
      author: comment.user?.name ?? 'unknown',
      body: comment.body,
      createdAt: comment.createdAt,
    })),
    links: node.relations.nodes.map(({ relatedIssue }) => ({
      url: relatedIssue.url,
      title: `${relatedIssue.identifier} ${relatedIssue.title}`,
    })),
    attachments: node.attachments.nodes.map(({ title, url }) => ({ name: title, url })),
    raw: node,
  };
}
