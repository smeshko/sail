// The Linear TicketSource: tickets of one Linear team, read with their comments, relations and attachments, claimed and
// moved by state type (DECISIONS D4), whatever the team calls its states, and filed in it with the labels it and the
// workspace hold. Every request goes through the GraphQL client, so each failure keeps Linear's message. The definition
// reads the API key, and the endpoint, from the operator's environment alone (D3).
import { z } from 'zod';
import type { ProviderEvent } from '../../events/types';
import type { AdapterDefinition } from '../../ports/adapter';
import { PortError } from '../../ports/errors';
import type { ProviderOptions, TicketSource } from '../../ports/ticket-source';
import { type Ticket, TicketMove, type TicketState } from '../../ports/types';
import { createLinearClient, type Fetch, LINEAR_ENDPOINT } from './linear-client';
import { COMMENT_FIELDS, stateTypeOf, TICKET_FIELDS, toTicket } from './linear-ticket';

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

// The list names the tickets only. Fifty tickets with their five connections would score about 130,000 points of
// Linear's query complexity, over its 10,000 cap, so each listed ticket is read as `get` reads it.
const DESIGNATED = `query SailDesignated($team: String!, $label: String!, $types: [String!], $after: String) {
  issues(
    filter: { team: { key: { eq: $team } }, labels: { some: { name: { eq: $label } } }, state: { type: { in: $types } } }
    first: 50
    after: $after
  ) { nodes { identifier } pageInfo { hasNextPage endCursor } }
}`;

const TEAM = `query SailTeam($team: String!) {
  teams(filter: { key: { eq: $team } }) { nodes { id key states { nodes { id name type position } } } }
}`;

const MOVE = `mutation SailMove($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id state { id name type } } }
}`;

const COMMENT = `mutation SailComment($id: String!, $body: String!) {
  commentCreate(input: { issueId: $id, body: $body }) { success comment { id url } }
}`;

// The team's id, and the labels its tickets can carry: the team's own and the workspace's, read on each create.
const TEAM_LABELS = `query SailTeamLabels($team: String!, $after: String) {
  teams(filter: { key: { eq: $team } }, first: 1) { nodes { id } }
  issueLabels(
    filter: { or: [{ team: { key: { eq: $team } } }, { team: { null: true } }] }
    first: 250
    after: $after
  ) { nodes { id name } pageInfo { hasNextPage endCursor } }
}`;

const CREATE = `mutation SailCreate($teamId: String!, $title: String!, $description: String!, $labelIds: [String!]!) {
  issueCreate(input: { teamId: $teamId, title: $title, description: $description, labelIds: $labelIds }) {
    success
    issue { id identifier url }
  }
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
interface LinearState {
  id: string;
  name: string;
  type: string;
  position: number;
}

/**
 * The cursor of the page after `page`, or null after the last. A page that says another follows but gives no cursor, or
 * one already `seen`, is a PortError `unavailable` of `op`: asking again would loop, and stopping would cut `what` short.
 */
function nextCursor(op: string, what: string, page: Page<unknown>, seen: Set<string>): string | null {
  const { hasNextPage, endCursor } = page.pageInfo;
  if (!hasNextPage) return null;
  if (endCursor === null || seen.has(endCursor)) {
    const gave = endCursor === null ? 'no cursor' : `cursor ${endCursor} again`;
    throw new PortError(
      'ticketSource',
      op,
      'unavailable',
      `Linear said another page of ${what} follows, but gave ${gave}`,
    );
  }
  seen.add(endCursor);
  return endCursor;
}

/** A state as the port reports it: its type and name, nothing of Linear's. */
const portState = (state: { name: string; type: string }, op: string): TicketState => ({
  type: stateTypeOf(state.type, op),
  name: state.name,
});

export function createLinearTicketSource(options: LinearTicketSourceOptions): TicketSource {
  const { team, inReview } = options;
  const client = createLinearClient({
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const now = () => options.now?.() ?? new Date();
  const emit = (event: ProviderEvent) => options.emit?.(event);
  let teamStates: LinearState[] | undefined;

  /** The ticket node and every page of its comments, or a PortError of `op`. Emits nothing. */
  async function lookup(op: string, ticketKey: string): Promise<{ node: Node; comments: unknown[] }> {
    const found = await read(op, ticketKey);
    if (found === undefined)
      throw new PortError('ticketSource', op, 'not_found', `no ticket ${ticketKey} in team ${team}`);
    return found;
  }

  /**
   * As `lookup`, but undefined when the team, which Linear has, holds no such ticket: one deleted, or moved to another
   * team. A team Linear doesn't have is still a PortError.
   */
  async function read(op: string, ticketKey: string): Promise<{ node: Node; comments: unknown[] } | undefined> {
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
    if (node === undefined) {
      // A team Linear doesn't have answers no ticket too: say which it is.
      await states(op);
      return undefined;
    }
    const comments = [...node.comments.nodes];
    const seen = new Set<string>();
    const what = `the comments of ${ticketKey}`;
    for (let after = nextCursor(op, what, node.comments, seen); after !== null; ) {
      const more = await client.request<{ issue: { comments: Page<unknown> } }>(
        op,
        'SailTicketComments',
        TICKET_COMMENTS,
        { id: node.id, after },
      );
      comments.push(...more.issue.comments.nodes);
      after = nextCursor(op, what, more.issue.comments, seen);
    }
    return { node, comments };
  }

  /**
   * A listed ticket read as `read` reads it. A ticket deleted between two of its requests, such as its first read and
   * a comment page, makes Linear refuse the later one: a refusal (`invalid`, `not_found`) is read once more from the
   * start, and the ticket is skipped when the team no longer holds it. Any other failure, or a second refusal, rejects.
   */
  async function readListed(ticketKey: string): Promise<{ node: Node; comments: unknown[] } | undefined> {
    try {
      return await read('listDesignated', ticketKey);
    } catch (error) {
      if (!(error instanceof PortError) || !['invalid', 'not_found'].includes(error.code)) throw error;
      return read('listDesignated', ticketKey);
    }
  }

  async function states(op: string): Promise<LinearState[]> {
    if (teamStates !== undefined) return teamStates;
    const data = await client.request<{ teams: { nodes: { states: { nodes: LinearState[] } }[] } }>(
      op,
      'SailTeam',
      TEAM,
      {
        team,
      },
    );
    const [found] = data.teams.nodes;
    if (found === undefined) throw new PortError('ticketSource', op, 'not_found', `Linear has no team ${team}`);
    teamStates = [...found.states.nodes].sort((a, b) => a.position - b.position);
    return teamStates;
  }

  /** The id of the state `move` lands on. */
  async function target(op: string, move: TicketMove): Promise<string> {
    const all = await states(op);
    const ofType = (type: string) => all.filter((state) => state.type === type);
    const review = inReview === undefined ? undefined : ofType('started').find((state) => state.name === inReview);
    if (move === 'in-review' && review === undefined) {
      throw new PortError(
        'ticketSource',
        op,
        'invalid',
        inReview === undefined
          ? 'in-review is no move without the inReview option'
          : `the inReview option names '${inReview}', which is no started state of team ${team}`,
      );
    }
    const chosen =
      move === 'in-review'
        ? review
        : move === 'in-progress'
          ? ofType('started').find((state) => state.name !== inReview)
          : move === 'done'
            ? ofType('completed')[0]
            : (ofType('unstarted')[0] ?? ofType('backlog')[0]);
    if (chosen === undefined)
      throw new PortError('ticketSource', op, 'invalid', `team ${team} has no state for ${move}`);
    return chosen.id;
  }

  async function move(op: string, id: string, to: TicketMove): Promise<{ state: TicketState; raw: object }> {
    const stateId = await target(op, to);
    const data = await client.request<{
      issueUpdate: { success: boolean; issue: { state: { name: string; type: string } } | null };
    }>(op, 'SailMove', MOVE, { id, stateId });
    if (!data.issueUpdate.success || data.issueUpdate.issue === null) {
      throw new PortError('ticketSource', op, 'conflict', `Linear did not move ticket ${id}`, data);
    }
    return { state: portState(data.issueUpdate.issue.state, op), raw: data };
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
      const keys: string[] = [];
      const seen = new Set<string>();
      let after: string | null = null;
      do {
        const data: { issues: Page<{ identifier: string }> } = await client.request(
          'listDesignated',
          'SailDesignated',
          DESIGNATED,
          { team, label, types: UNSTARTED_TYPES, after },
        );
        keys.push(...data.issues.nodes.map((node) => node.identifier));
        after = nextCursor('listDesignated', 'the designated tickets', data.issues, seen);
      } while (after !== null);
      // A team Linear doesn't have lists nothing too: an empty list is checked against the team's existence.
      if (keys.length === 0) await states('listDesignated');
      const tickets: Ticket[] = [];
      for (const key of keys) {
        // Read after the list: a ticket deleted, moved to another team, claimed or unlabelled since is not listed.
        const found = await readListed(key);
        if (found === undefined) continue;
        const ticket = toTicket(found.node, found.comments, 'listDesignated');
        if (ticket.state.type === 'unstarted' && ticket.labels.includes(label)) tickets.push(ticket);
      }
      const number = (ticket: Ticket) => Number(ticket.ticketKey.slice(ticket.ticketKey.indexOf('-') + 1));
      return tickets.sort((a, b) => number(a) - number(b));
    },
    async claim(ticketKey) {
      const { node } = await lookup('claim', ticketKey);
      const read = (node as unknown as { state: { name: string; type: string } }).state;
      const state = portState(read, 'claim');
      if (state.type !== 'unstarted') return { claimed: false, state, raw: node };
      const moved = await move('claim', node.id, 'in-progress');
      emit({ type: 'ticket:claimed', ticketKey, state: moved.state });
      return { claimed: true, ...moved };
    },
    async update(ticketKey, change) {
      if (!TicketMove.safeParse(change.state).success) {
        throw new PortError('ticketSource', 'update', 'invalid', `${String(change.state)} is not a move`);
      }
      const { node } = await lookup('update', ticketKey);
      const moved = await move('update', node.id, change.state);
      emit({ type: 'ticket:updated', ticketKey, change: { state: change.state }, state: moved.state });
      return moved;
    },
    async comment(ticketKey, body) {
      const { node } = await lookup('comment', ticketKey);
      const data = await client.request<{
        commentCreate: { success: boolean; comment: { id: string; url: string } | null };
      }>('comment', 'SailComment', COMMENT, { id: node.id, body });
      if (!data.commentCreate.success || data.commentCreate.comment === null) {
        throw new PortError(
          'ticketSource',
          'comment',
          'conflict',
          `Linear did not post the comment on ${ticketKey}`,
          data,
        );
      }
      emit({ type: 'ticket:commented', ticketKey, body });
      return { id: data.commentCreate.comment.id, url: data.commentCreate.comment.url, raw: data };
    },
    async create({ title, description, labels }) {
      // Every label is resolved before anything is filed: a name the team lacks files no ticket.
      const known: { id: string; name: string }[] = [];
      const seen = new Set<string>();
      let teamId: string | undefined;
      let after: string | null = null;
      do {
        const read: { teams: { nodes: { id: string }[] }; issueLabels: Page<{ id: string; name: string }> } =
          await client.request('create', 'SailTeamLabels', TEAM_LABELS, { team, after });
        const [found] = read.teams.nodes;
        if (found === undefined) {
          throw new PortError('ticketSource', 'create', 'not_found', `Linear has no team ${team}`);
        }
        teamId = found.id;
        known.push(...read.issueLabels.nodes);
        after = nextCursor('create', `the labels of team ${team}`, read.issueLabels, seen);
      } while (after !== null);
      const labelIds = labels.map((name) => {
        const label = known.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
        if (label === undefined) {
          throw new PortError('ticketSource', 'create', 'invalid', `team ${team} has no label ${name}`);
        }
        return label.id;
      });
      const data = await client.request<{
        issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null };
      }>('create', 'SailCreate', CREATE, { teamId, title, description, labelIds });
      if (!data.issueCreate.success || data.issueCreate.issue === null) {
        throw new PortError(
          'ticketSource',
          'create',
          'conflict',
          `Linear did not create the ticket in team ${team}`,
          data,
        );
      }
      const { identifier: ticketKey, url } = data.issueCreate.issue;
      emit({ type: 'ticket:created', ticketKey, title, url });
      return { ticketKey, url, raw: data };
    },
    capabilities: () => ({
      comments: true,
      links: true,
      attachments: true,
      moves: ['unstarted', 'in-progress', ...(inReview === undefined ? [] : (['in-review'] as const)), 'done'],
    }),
  };
}

const LinearOptions = z.strictObject({
  team: z.string().regex(/^[A-Z][A-Z0-9]*$/, 'must be a Linear team key, such as ADW'),
  inReview: z.string().min(1).optional(),
});

/** `linear` in `project.yaml`: `team` is required, `inReview` optional, and the key comes from `LINEAR_API_KEY`. */
export const linearTicketSource: AdapterDefinition<TicketSource> = {
  requires: () => ['LINEAR_API_KEY'],
  create(options, context) {
    const parsed = LinearOptions.safeParse(options);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const option = issue?.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue?.path.join('.');
      throw new Error(`linear ticketSource: option ${option}: ${issue?.message}`);
    }
    return createLinearTicketSource({
      team: parsed.data.team,
      ...(parsed.data.inReview === undefined ? {} : { inReview: parsed.data.inReview }),
      apiKey: context.env.LINEAR_API_KEY ?? '',
      endpoint: context.env.SAIL_LINEAR_API_URL || LINEAR_ENDPOINT,
      ...(context.emit === undefined ? {} : { emit: context.emit }),
      ...(context.now === undefined ? {} : { now: context.now }),
    });
  },
};
