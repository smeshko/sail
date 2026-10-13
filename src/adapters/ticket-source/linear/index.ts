// The Linear TicketSource: the adapter over Linear's GraphQL API, and its adapter definition, which the built-in
// registration hands the registry (DECISIONS §1 to §6).
// Stub: the definition is written in TASK-006.

import { z } from 'zod';
import type { ProviderEvent } from '../../../events/types';
import type { AdapterDefinition, AdapterOptions } from '../../../ports/adapter';
import { PortError } from '../../../ports/errors';
import type { ProviderOptions, TicketSource } from '../../../ports/ticket-source';
import { type Moved, type Ticket, TicketMove, type TicketState } from '../../../ports/types';
import { createLinearClient } from './client';
import { stateTypeOf, toTicket } from './normalise';
import {
  type CommentNode,
  CREATE_COMMENT,
  type CreateCommentData,
  FETCH_ISSUE,
  FETCH_MORE_COMMENTS,
  type FetchIssueData,
  type FetchMoreCommentsData,
  type IssueNode,
  LIST_ISSUES,
  type ListIssuesData,
  UPDATE_ISSUE,
  type UpdateIssueData,
} from './queries';
import { createTeamStates } from './states';

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

export function createLinearTicketSource(options: LinearTicketSourceOptions): TicketSource {
  const client = createLinearClient({ apiKey: options.apiKey, fetch: options.fetch });
  const states = createTeamStates(client, options.team);
  const now = options.now ?? (() => new Date());
  const emit = (event: ProviderEvent) => options.emit?.(event);

  // A key of another team is not this adapter's: undefined, so the engine's refusal applies.
  const parseKey = (ref: string): string | undefined => {
    const key = KEY.test(ref) ? ref : URL_KEY.exec(ref)?.[1];
    return key?.startsWith(`${options.team}-`) ? key : undefined;
  };

  /** The issue a ticket key names, or a PortError `not_found` naming the operation that asked. */
  const fetchNode = async (ticketKey: string, op: string): Promise<IssueNode> => {
    const key = parseKey(ticketKey);
    const data =
      key === undefined
        ? undefined
        : ((await client.request('FetchIssue', FETCH_ISSUE, {
            team: options.team,
            number: Number(key.slice(options.team.length + 1)),
          })) as FetchIssueData);
    const node = data?.issues.nodes[0];
    if (node === undefined) throw new PortError('ticketSource', op, 'not_found', `no ticket ${ticketKey}`);
    return node;
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

  /** Moves `node` to `stateId`. A move Linear reports as not successful is a PortError `conflict`, and nothing is emitted. */
  const writeMove = async (
    node: IssueNode,
    op: string,
    stateId: string,
  ): Promise<{ state: TicketState; raw: object }> => {
    const data = (await client.request('UpdateIssue', UPDATE_ISSUE, { id: node.id, stateId })) as UpdateIssueData;
    const issue = data.issueUpdate.issue;
    if (!data.issueUpdate.success || issue === null) {
      throw new PortError('ticketSource', op, 'conflict', `Linear did not move ${node.identifier}`);
    }
    const state = { type: stateTypeOf(issue.state.type, op), name: issue.state.name };
    return { state, raw: { ...node, state: issue.state } };
  };

  return {
    name: 'linear',
    parseKey,
    async get(ticketKey) {
      const started = now().getTime();
      const node = await fetchNode(ticketKey, 'get');
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
    async claim(ticketKey) {
      const node = await fetchNode(ticketKey, 'claim');
      const current = { type: stateTypeOf(node.state.type, 'claim'), name: node.state.name };
      // A ticket that is not unstarted is not taken: no write, and nothing emitted.
      if (current.type !== 'unstarted') return { claimed: false, state: current, raw: node };
      const moved = await writeMove(node, 'claim', await states.targetFor('claim', 'in-progress'));
      emit({ type: 'ticket:claimed', ticketKey: node.identifier, state: moved.state });
      return { claimed: true, state: moved.state, raw: moved.raw };
    },
    async update(ticketKey, change) {
      // A move from outside TypeScript, such as `sail port`, is checked before any request is sent.
      if (!TicketMove.safeParse(change.state).success) {
        throw new PortError('ticketSource', 'update', 'invalid', `${String(change.state)} is not a move`);
      }
      const node = await fetchNode(ticketKey, 'update');
      const target = await states.targetFor('update', change.state, options.inReviewState);
      const moved: Moved = await writeMove(node, 'update', target);
      emit({ type: 'ticket:updated', ticketKey: node.identifier, change: { state: change.state }, state: moved.state });
      return moved;
    },
    async comment(ticketKey, body) {
      const node = await fetchNode(ticketKey, 'comment');
      const data = (await client.request('CreateComment', CREATE_COMMENT, {
        issueId: node.id,
        body,
      })) as CreateCommentData;
      const created = data.commentCreate.comment;
      if (!data.commentCreate.success || created === null) {
        throw new PortError(
          'ticketSource',
          'comment',
          'conflict',
          `Linear did not post the comment on ${node.identifier}`,
        );
      }
      emit({ type: 'ticket:commented', ticketKey: node.identifier, body });
      return { id: created.id, url: created.url, raw: created };
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

const LinearOptions = z.strictObject({
  team: z.string().regex(/^[A-Z][A-Z0-9]*$/, 'team must be an upper-case team key, such as ADW'),
  inReviewState: z.string().min(1).optional(),
});

/** Parses the adapter's options with the strict object, or throws naming the offending option. */
function parseOptions(options: AdapterOptions): z.infer<typeof LinearOptions> {
  const parsed = LinearOptions.safeParse(options);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const option = issue?.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue?.path.join('.');
  throw new Error(`linear ticketSource: option ${option}: ${issue?.message}`);
}

/** The built-in `linear` ticket source: its options, its credential and its creation. */
export const linearAdapters: { ticketSource: AdapterDefinition<TicketSource> } = {
  ticketSource: {
    requires: () => ['LINEAR_API_KEY'],
    create(options, context) {
      const { team, inReviewState } = parseOptions(options);
      const apiKey = context.env.LINEAR_API_KEY;
      if (apiKey === undefined) throw new Error('LINEAR_API_KEY is not set');
      return createLinearTicketSource({
        apiKey,
        team,
        ...(inReviewState === undefined ? {} : { inReviewState }),
        ...(context.emit === undefined ? {} : { emit: context.emit }),
        ...(context.now === undefined ? {} : { now: context.now }),
      });
    },
  },
};
