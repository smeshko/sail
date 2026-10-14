// The Linear TicketSource: tickets of one Linear team, read with their comments, relations and attachments, claimed and
// moved by state type (DECISIONS D4), whatever the team calls its states. Every request goes through the GraphQL client,
// so each failure keeps Linear's message. The definition reads the API key, and the endpoint, from the operator's
// environment alone (D3).
//
// TDD stub (linear-ticket-source TASK-004 to TASK-005): the reads are final, the writes and the definition answer wrong.
// The stub is registered in BUILTINS already, so the built-in lists the existing tests name stay true from here on.
import type { ProviderEvent } from '../../events/types';
import type { AdapterDefinition } from '../../ports/adapter';
import { PortError } from '../../ports/errors';
import type { ProviderOptions, TicketSource } from '../../ports/ticket-source';
import type { Ticket } from '../../ports/types';
import { createLinearClient, type Fetch, LINEAR_ENDPOINT } from './linear-client';
import { COMMENT_FIELDS, TICKET_FIELDS, toTicket } from './linear-ticket';

export interface LinearTicketSourceOptions extends ProviderOptions {
  /** The team key, such as `ADW`. */
  readonly team: string;
  /** The name of the team's `started` state that `in-review` moves to. Without it, `in-review` isn't a move. */
  readonly inReview?: string;
  readonly endpoint: string;
  readonly apiKey: string;
  readonly fetch?: Fetch;
}

const TICKET = `query SailTicket($team: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) { nodes { ${TICKET_FIELDS} } }
}`;

const TICKET_COMMENTS = `query SailTicketComments($id: String!, $after: String) {
  issue(id: $id) { comments(first: 250, after: $after) { nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage endCursor } } }
}`;

const DESIGNATED = `query SailDesignated($team: String!, $label: String!, $types: [String!], $after: String) {
  issues(
    filter: { team: { key: { eq: $team } }, labels: { some: { name: { eq: $label } } }, state: { type: { in: $types } } }
    first: 50
    after: $after
  ) { nodes { ${TICKET_FIELDS} } pageInfo { hasNextPage endCursor } }
}`;

/** The Linear state types a designated ticket may be in to be listed: those sail reads as unstarted. */
const UNSTARTED_TYPES = ['triage', 'backlog', 'unstarted'];

const KEY = /^([A-Z][A-Z0-9]*)-([1-9]\d*)$/;
const URL_KEY = /^https:\/\/linear\.app\/[^/?#]+\/issue\/([A-Z][A-Z0-9]*-[1-9]\d*)(?:\/[^/?#]*)?\/?(?:[?#].*)?$/;

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface Node {
  id: string;
  number: number;
  comments: Page<unknown>;
}

const NOWHERE = { type: 'unstarted', name: '' } as const;

export function createLinearTicketSource(options: LinearTicketSourceOptions): TicketSource {
  const { team } = options;
  const client = createLinearClient({
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const now = () => options.now?.() ?? new Date();
  const emit = (event: ProviderEvent) => options.emit?.(event);

  /** The ticket node and every page of its comments, or a PortError of `op`. Emits nothing. */
  async function lookup(op: string, ticketKey: string): Promise<{ node: Node; comments: unknown[] }> {
    const [, keyTeam = '', number = ''] = KEY.exec(ticketKey) ?? [];
    if (keyTeam !== team) {
      throw new PortError(
        'ticketSource',
        op,
        'invalid',
        `${ticketKey} is a ticket of team ${keyTeam || '?'}, and this ticket source reads team ${team}`,
      );
    }
    const data = await client.request<{ issues: { nodes: Node[] } }>(op, 'SailTicket', TICKET, {
      team,
      number: Number(number),
    });
    const [node] = data.issues.nodes;
    if (node === undefined)
      throw new PortError('ticketSource', op, 'not_found', `no ticket ${ticketKey} in team ${team}`);
    const comments = [...node.comments.nodes];
    let page = node.comments.pageInfo;
    while (page.hasNextPage) {
      const more = await client.request<{ issue: { comments: Page<unknown> } }>(
        op,
        'SailTicketComments',
        TICKET_COMMENTS,
        {
          id: node.id,
          after: page.endCursor,
        },
      );
      comments.push(...more.issue.comments.nodes);
      page = more.issue.comments.pageInfo;
    }
    return { node, comments };
  }

  return {
    name: 'linear',
    parseKey: (ref) => (KEY.test(ref) ? ref : URL_KEY.exec(ref)?.[1]),
    async get(ticketKey) {
      const started = now().getTime();
      const { node, comments } = await lookup('get', ticketKey);
      const ticket = toTicket(node, comments, 'get');
      emit({
        type: 'ticket:fetched',
        ticketKey,
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
    async listDesignated(label) {
      const tickets: Ticket[] = [];
      let after: string | null = null;
      do {
        const data: { issues: Page<Node> } = await client.request('listDesignated', 'SailDesignated', DESIGNATED, {
          team,
          label,
          types: UNSTARTED_TYPES,
          after,
        });
        for (const node of data.issues.nodes) tickets.push(toTicket(node, node.comments.nodes, 'listDesignated'));
        after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
      } while (after !== null);
      const number = (ticket: Ticket) => Number(ticket.ticketKey.slice(ticket.ticketKey.indexOf('-') + 1));
      return tickets.sort((a, b) => number(a) - number(b));
    },
    claim: async () => ({ claimed: false, state: { ...NOWHERE }, raw: null }),
    update: async () => ({ state: { ...NOWHERE }, raw: null }),
    comment: async () => ({ id: '', raw: null }),
    capabilities: () => ({ comments: false, links: false, attachments: false, moves: [] }),
  };
}

/** `linear` in `project.yaml`: `team` is required, `inReview` optional, and the key comes from `LINEAR_API_KEY`. */
export const linearTicketSource: AdapterDefinition<TicketSource> = {
  requires: () => [],
  create: () => createLinearTicketSource({ team: '', endpoint: LINEAR_ENDPOINT, apiKey: '' }),
};
