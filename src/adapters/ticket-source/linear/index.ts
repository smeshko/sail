// The Linear TicketSource: the adapter over Linear's GraphQL API, and its adapter definition, which the built-in
// registration hands the registry (DECISIONS §1 to §6).
// Stub: listDesignated, claim, update, comment and the definition are written in TASK-004 to TASK-006.
import type { ProviderEvent } from '../../../events/types';
import type { AdapterDefinition } from '../../../ports/adapter';
import { PortError } from '../../../ports/errors';
import type { ProviderOptions, TicketSource } from '../../../ports/ticket-source';
import type { Ticket } from '../../../ports/types';
import { createLinearClient } from './client';
import { toTicket } from './normalise';
import {
  type CommentNode,
  FETCH_ISSUE,
  FETCH_MORE_COMMENTS,
  type FetchIssueData,
  type FetchMoreCommentsData,
  type IssueNode,
  LIST_ISSUES,
  type ListIssuesData,
} from './queries';

export interface LinearTicketSourceOptions extends ProviderOptions {
  /** The key from `LINEAR_API_KEY`. It is sent as the Authorization header and nowhere else. */
  readonly apiKey: string;
  /** The team key, such as `ADW`. Ticket keys of any other team are not this adapter's. */
  readonly team: string;
  /** The name of the started state that means in review. Without it, `in-review` is not a move. */
  readonly inReviewState?: string;
  /** The transport. Left out, the client reads `globalThis.fetch` at each call. */
  readonly fetch?: typeof fetch;
}

/** A ticket key: a team key and a number. A bare key, or a key inside an issue URL the provider owns. */
const KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const URL_KEY = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/|$)/;

const notYetWritten = (op: string) => new PortError('ticketSource', op, 'invalid', 'not implemented yet');

export function createLinearTicketSource(options: LinearTicketSourceOptions): TicketSource {
  const client = createLinearClient({ apiKey: options.apiKey, fetch: options.fetch });
  const now = options.now ?? (() => new Date());
  const emit = (event: ProviderEvent) => options.emit?.(event);

  // A key of another team is not this adapter's: undefined, so the engine's refusal applies.
  const parseKey = (ref: string): string | undefined => {
    const key = KEY.test(ref) ? ref : URL_KEY.exec(ref)?.[1];
    return key?.startsWith(`${options.team}-`) ? key : undefined;
  };

  /** The comments of one issue, every page of them, in order. */
  const allComments = async (node: IssueNode): Promise<CommentNode[]> => {
    const comments = [...node.comments.nodes];
    let page = node.comments.pageInfo;
    while (page.hasNextPage && page.endCursor !== null) {
      const data = (await client.request('FetchMoreComments', FETCH_MORE_COMMENTS, {
        id: node.id,
        after: page.endCursor,
      })) as FetchMoreCommentsData;
      const next = data.issue?.comments;
      if (next === undefined || next === null) {
        throw new PortError('ticketSource', 'get', 'invalid', `Linear answered no comments for ${node.identifier}`);
      }
      comments.push(...next.nodes);
      page = next.pageInfo;
    }
    return comments;
  };

  /** Every designated ticket in a backlog or unstarted state, every page of the listing, with its comments. */
  const listDesignated = async (label: string): Promise<Ticket[]> => {
    const tickets: Ticket[] = [];
    let after: string | undefined;
    let more = true;
    while (more) {
      const { issues } = (await client.request('ListIssues', LIST_ISSUES, {
        team: options.team,
        label,
        first: 100,
        after,
      })) as ListIssuesData;
      for (const node of issues.nodes) {
        const ticket = toTicket(node, await allComments(node));
        // The server filters by type already; the state is checked again, so a broad filter cannot list a started ticket.
        if (ticket.state.type === 'unstarted' && ticket.labels.includes(label)) tickets.push(ticket);
      }
      more = issues.pageInfo.hasNextPage && issues.pageInfo.endCursor !== null;
      after = issues.pageInfo.endCursor ?? undefined;
    }
    return tickets;
  };

  return {
    name: 'linear',
    parseKey,
    async get(ticketKey) {
      const started = now().getTime();
      const key = parseKey(ticketKey);
      const data =
        key === undefined
          ? undefined
          : ((await client.request('FetchIssue', FETCH_ISSUE, {
              team: options.team,
              number: Number(key.slice(options.team.length + 1)),
            })) as FetchIssueData);
      const node = data?.issues.nodes[0];
      if (node === undefined) throw new PortError('ticketSource', 'get', 'not_found', `no ticket ${ticketKey}`);

      const ticket: Ticket = toTicket(node, await allComments(node));
      emit({
        type: 'ticket:fetched',
        ticketKey: ticket.ticketKey,
        title: ticket.title,
        url: ticket.url,
        comments: ticket.comments.length,
        links: ticket.links.length,
        attachments: ticket.attachments.length,
        durationMs: Math.max(0, now().getTime() - started),
      });
      return ticket;
    },
    isDesignated: (ticket, label) => ticket.labels.includes(label),
    listDesignated,
    claim: async () => {
      throw notYetWritten('claim');
    },
    update: async () => {
      throw notYetWritten('update');
    },
    comment: async () => {
      throw notYetWritten('comment');
    },
    capabilities: () => ({
      comments: true,
      links: true,
      attachments: true,
      moves:
        options.inReviewState === undefined
          ? ['unstarted', 'in-progress', 'done']
          : ['unstarted', 'in-progress', 'in-review', 'done'],
    }),
  };
}

/** The built-in `linear` ticket source: its options, its credential and its creation. */
export const linearAdapters: { ticketSource: AdapterDefinition<TicketSource> } = {
  ticketSource: {
    create: () => createLinearTicketSource({ apiKey: '', team: '' }),
  },
};
