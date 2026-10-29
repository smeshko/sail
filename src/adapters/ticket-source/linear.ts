// The Linear TicketSource: tickets of one Linear team, read with their comments, relations and attachments, claimed and
// moved by state type (DECISIONS D4), whatever the team calls its states, filed in it with the labels it and the
// workspace hold, and given files: uploaded to Linear's storage, then attached. Every GraphQL request goes through the
// client, so each failure keeps Linear's message. The definition reads the API key, and the endpoint, from the
// operator's environment alone (D3).
import { z } from 'zod';
import type { ProviderEvent } from '../../events/types';
import type { AdapterDefinition } from '../../ports/adapter';
import { PortError } from '../../ports/errors';
import { checkAttachment, type ProviderOptions, type TicketSource } from '../../ports/ticket-source';
import {
  type ListedTicket,
  type Relabelled,
  type Ticket,
  TicketMove,
  TicketRelation,
  type TicketState,
  TicketStateType,
} from '../../ports/types';
import { createLinearClient, type Fetch, LINEAR_ENDPOINT } from './linear-client';
import { COMMENT_FIELDS, stateTypeOf, TICKET_FIELDS, toTicket } from './linear-ticket';

export interface LinearTicketSourceOptions extends ProviderOptions {
  /** The team key, such as `ADW`. */
  readonly team: string;
  /** The name of the team's `started` state that `in-review` moves to. Without it, `in-review` isn't a move. */
  readonly inReview?: string;
  /**
   * The names of the states a designated ticket is picked up from, such as `Todo`. Every triage, backlog and unstarted
   * state when left out. `openLinearTicketSource` checks them against the team's states.
   */
  readonly pickUp?: readonly string[];
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

// A list carries each ticket's own fields and its labels, not its comments, relations and attachments, which keeps a
// page of fifty well inside the complexity cap. The label filter is in the document only when a label is asked for.
const list = (
  withLabel: boolean,
) => `query SailList($team: String!, $types: [String!], ${withLabel ? '$label: String, ' : ''}$after: String) {
  issues(
    filter: { team: { key: { eq: $team } }, ${withLabel ? 'labels: { some: { name: { eq: $label } } }, ' : ''}state: { type: { in: $types } } }
    first: 50
    after: $after
  ) {
    nodes { identifier title description url state { name type } labels(first: 50) { nodes { name } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

// As DESIGNATED, with the states named too: the tickets in a backlog the source doesn't pick up are not listed to be read.
const DESIGNATED_IN = `query SailDesignated($team: String!, $label: String!, $types: [String!], $names: [String!], $after: String) {
  issues(
    filter: {
      team: { key: { eq: $team } }
      labels: { some: { name: { eq: $label } } }
      state: { type: { in: $types }, name: { in: $names } }
    }
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

const ADD_LABEL = `mutation SailAddLabel($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) { success issue { labels(first: 250) { nodes { name } } } }
}`;

const REMOVE_LABEL = `mutation SailRemoveLabel($id: String!, $labelId: String!) {
  issueRemoveLabel(id: $id, labelId: $labelId) { success issue { labels(first: 250) { nodes { name } } } }
}`;

const RELATE = `mutation SailRelate($id: String!, $relatedId: String!, $type: IssueRelationType!) {
  issueRelationCreate(input: { issueId: $id, relatedIssueId: $relatedId, type: $type }) { success issueRelation { id } }
}`;

const EDIT = `mutation SailEdit($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id identifier url } }
}`;

// A signed URL to PUT the file's bytes to, with the headers the PUT must carry, and the URL the file is served at.
const UPLOAD = `mutation SailUpload($contentType: String!, $filename: String!, $size: Int!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size) {
    success
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}`;

const ATTACH = `mutation SailAttach($issueId: String!, $url: String!, $title: String!) {
  attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) { success attachment { id url } }
}`;

/** How long the PUT of a file's bytes may take. */
const UPLOAD_TIMEOUT_MS = 120_000;

/** The Linear state types sail reads as unstarted: the ones a designated ticket is picked up from, and a `pickUp` entry may be. */
const UNSTARTED_TYPES = ['triage', 'backlog', 'unstarted'];

/** The Linear state types each port state type covers: `canceled` takes Linear's duplicate type with its own. */
const LINEAR_TYPES: Record<TicketStateType, string[]> = {
  unstarted: UNSTARTED_TYPES,
  started: ['started'],
  completed: ['completed'],
  canceled: ['canceled', 'duplicate'],
};

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
interface ListedNode {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: { name: string; type: string };
  labels: { nodes: { name: string }[] };
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

function buildLinearTicketSource(options: LinearTicketSourceOptions): {
  source: TicketSource;
  checkPickUp(): Promise<void>;
} {
  const { team, inReview, pickUp } = options;
  const client = createLinearClient({
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const now = () => options.now?.() ?? new Date();
  const emit = (event: ProviderEvent) => options.emit?.(event);
  const send = options.fetch ?? fetch;
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

  /** The team's id and every label its tickets can carry, read page by page. */
  async function teamLabels(op: string): Promise<{ teamId: string; known: { id: string; name: string }[] }> {
    const known: { id: string; name: string }[] = [];
    const seen = new Set<string>();
    let teamId = '';
    let after: string | null = null;
    do {
      const read: { teams: { nodes: { id: string }[] }; issueLabels: Page<{ id: string; name: string }> } =
        await client.request(op, 'SailTeamLabels', TEAM_LABELS, { team, after });
      const [found] = read.teams.nodes;
      if (found === undefined) throw new PortError('ticketSource', op, 'not_found', `Linear has no team ${team}`);
      teamId = found.id;
      known.push(...read.issueLabels.nodes);
      after = nextCursor(op, `the labels of team ${team}`, read.issueLabels, seen);
    } while (after !== null);
    return { teamId, known };
  }

  /** The team's label named `name`, whatever its case, or an `invalid` PortError of `op`. */
  function labelOf(op: string, known: { id: string; name: string }[], name: string): { id: string; name: string } {
    const label = known.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (label === undefined) throw new PortError('ticketSource', op, 'invalid', `team ${team} has no label ${name}`);
    return label;
  }

  /** Adds or removes the label, after the ticket is found and the label resolved. A change that is already so sends nothing. */
  async function relabel(op: 'addLabel' | 'removeLabel', ticketKey: string, name: string): Promise<Relabelled> {
    const adding = op === 'addLabel';
    const { node } = await lookup(op, ticketKey);
    const { known } = await teamLabels(op);
    const label = labelOf(op, known, name);
    const carried = (node as unknown as { labels: { nodes: { name: string }[] } }).labels.nodes.map(
      (each) => each.name,
    );
    if (carried.includes(label.name) === adding) return { ticketKey, labels: carried, raw: node };
    const field = adding ? 'issueAddLabel' : 'issueRemoveLabel';
    const data = await client.request<
      Record<string, { success: boolean; issue: { labels: { nodes: { name: string }[] } } | null }>
    >(op, adding ? 'SailAddLabel' : 'SailRemoveLabel', adding ? ADD_LABEL : REMOVE_LABEL, {
      id: node.id,
      labelId: label.id,
    });
    const answered = data[field];
    if (answered === undefined || !answered.success || answered.issue === null) {
      throw new PortError(
        'ticketSource',
        op,
        'conflict',
        `Linear did not ${adding ? 'add' : 'remove'} the label ${label.name} on ${ticketKey}`,
        data,
      );
    }
    const labels = answered.issue.labels.nodes.map((each) => each.name);
    emit({ type: adding ? 'ticket:labelled' : 'ticket:unlabelled', ticketKey, label: label.name, labels });
    return { ticketKey, labels, raw: data };
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
            : move === 'canceled'
              ? ofType('canceled')[0]
              : pickUp === undefined
                ? (ofType('unstarted')[0] ?? ofType('backlog')[0])
                : all.find((state) => pickUp.includes(state.name));
    if (chosen === undefined)
      throw new PortError('ticketSource', op, 'invalid', `team ${team} has no state for ${move}`);
    return chosen.id;
  }

  /**
   * PUTs `bytes` to Linear's signed `uploadUrl` with the headers it asked for. A refused or failed PUT is a PortError of
   * `attach`: `forbidden` for a 401 or 403, which an expired signature gives, `unavailable` for anything else.
   */
  async function put(uploadUrl: string, headers: Record<string, string>, bytes: Uint8Array): Promise<void> {
    const host = URL.canParse(uploadUrl) ? new URL(uploadUrl).host : uploadUrl;
    let response: Response;
    try {
      response = await send(uploadUrl, {
        method: 'PUT',
        headers,
        body: bytes,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      const why = timedOut
        ? `did not answer within ${UPLOAD_TIMEOUT_MS} ms`
        : `is unreachable: ${error instanceof Error ? error.message : String(error)}`;
      throw new PortError('ticketSource', 'attach', 'unavailable', `Linear's upload host ${host} ${why}`);
    }
    if (response.ok) return;
    const text = await response.text().catch(() => '');
    const code = response.status === 401 || response.status === 403 ? 'forbidden' : 'unavailable';
    const words = text.trim().slice(0, 200);
    throw new PortError(
      'ticketSource',
      'attach',
      code,
      `Linear's upload host ${host} refused the file: ${response.status}${words === '' ? '' : ` ${words}`}`,
    );
  }

  async function move(op: string, id: string, to: TicketMove): Promise<{ state: TicketState; raw: object }> {
    return moveTo(op, id, await target(op, to));
  }

  async function moveTo(op: string, id: string, stateId: string): Promise<{ state: TicketState; raw: object }> {
    const data = await client.request<{
      issueUpdate: { success: boolean; issue: { state: { name: string; type: string } } | null };
    }>(op, 'SailMove', MOVE, { id, stateId });
    if (!data.issueUpdate.success || data.issueUpdate.issue === null) {
      throw new PortError('ticketSource', op, 'conflict', `Linear did not move ticket ${id}`, data);
    }
    return { state: portState(data.issueUpdate.issue.state, op), raw: data };
  }

  const canPickUp = (ticket: Pick<Ticket, 'state'>) =>
    ticket.state.type === 'unstarted' && (pickUp === undefined || pickUp.includes(ticket.state.name));

  const source: TicketSource = {
    name: 'linear',
    scope: team,
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
    canPickUp,
    async listDesignated(label) {
      const keys: string[] = [];
      const seen = new Set<string>();
      let after: string | null = null;
      do {
        const data: { issues: Page<{ identifier: string }> } = await client.request(
          'listDesignated',
          'SailDesignated',
          pickUp === undefined ? DESIGNATED : DESIGNATED_IN,
          { team, label, types: UNSTARTED_TYPES, ...(pickUp === undefined ? {} : { names: pickUp }), after },
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
        if (canPickUp(ticket) && ticket.labels.includes(label)) tickets.push(ticket);
      }
      const number = (ticket: Ticket) => Number(ticket.ticketKey.slice(ticket.ticketKey.indexOf('-') + 1));
      return tickets.sort((a, b) => number(a) - number(b));
    },
    async list(filter) {
      if (filter.state !== undefined && !TicketStateType.safeParse(filter.state).success) {
        throw new PortError('ticketSource', 'list', 'invalid', `${String(filter.state)} is not a ticket state`);
      }
      const types = filter.state === undefined ? Object.values(LINEAR_TYPES).flat() : LINEAR_TYPES[filter.state];
      const document = list(filter.label !== undefined);
      const listed: ListedTicket[] = [];
      const seen = new Set<string>();
      let after: string | null = null;
      do {
        const data: { issues: Page<ListedNode> } = await client.request('list', 'SailList', document, {
          team,
          types,
          ...(filter.label === undefined ? {} : { label: filter.label }),
          after,
        });
        for (const node of data.issues.nodes) {
          listed.push({
            ticketKey: node.identifier,
            title: node.title,
            url: node.url,
            description: node.description ?? '',
            state: portState(node.state, 'list'),
            labels: node.labels.nodes.map((label) => label.name),
            raw: node,
          });
        }
        after = nextCursor('list', 'the team’s tickets', data.issues, seen);
      } while (after !== null);
      // A team Linear doesn't have lists nothing too: an empty list is checked against the team's existence.
      if (listed.length === 0) await states('list');
      const number = (ticket: ListedTicket) => Number(ticket.ticketKey.slice(ticket.ticketKey.indexOf('-') + 1));
      return listed.sort((a, b) => number(a) - number(b));
    },
    async claim(ticketKey) {
      const { node } = await lookup('claim', ticketKey);
      const read = (node as unknown as { state: { name: string; type: string } }).state;
      const state = portState(read, 'claim');
      if (!canPickUp({ state })) return { claimed: false, state, raw: node };
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
      const { teamId, known } = await teamLabels('create');
      const labelIds = labels.map((name) => labelOf('create', known, name).id);
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
    addLabel: (ticketKey, label) => relabel('addLabel', ticketKey, label),
    removeLabel: (ticketKey, label) => relabel('removeLabel', ticketKey, label),
    async relate(ticketKey, { kind, to }) {
      if (!TicketRelation.safeParse(kind).success) {
        throw new PortError('ticketSource', 'relate', 'invalid', `${String(kind)} is not a relation`);
      }
      if (to === ticketKey) {
        throw new PortError('ticketSource', 'relate', 'invalid', `${ticketKey} can't be related to itself`);
      }
      const { node } = await lookup('relate', ticketKey);
      const { node: other } = await lookup('relate', to);
      const current = (node as unknown as { state: { name: string; type: string } }).state;
      // The state a duplicate closes in is chosen before the relation is made, so a team without one changes nothing.
      let closing: LinearState | undefined;
      if (kind === 'duplicate' && !['canceled', 'duplicate'].includes(current.type)) {
        const all = await states('relate');
        closing = all.find((state) => state.type === 'duplicate') ?? all.find((state) => state.type === 'canceled');
        if (closing === undefined) {
          throw new PortError('ticketSource', 'relate', 'invalid', `team ${team} has no state for duplicate`);
        }
      }
      const data = await client.request<{
        issueRelationCreate: { success: boolean; issueRelation: { id: string } | null };
      }>('relate', 'SailRelate', RELATE, { id: node.id, relatedId: other.id, type: kind });
      if (!data.issueRelationCreate.success || data.issueRelationCreate.issueRelation === null) {
        throw new PortError(
          'ticketSource',
          'relate',
          'conflict',
          `Linear did not relate ${ticketKey} to ${to} as ${kind}`,
          data,
        );
      }
      const moved = closing === undefined ? undefined : await moveTo('relate', node.id, closing.id);
      const state = moved?.state ?? portState(current, 'relate');
      emit({ type: 'ticket:related', ticketKey, kind, to, state });
      return { ticketKey, kind, to, state, raw: moved === undefined ? data : { relation: data, move: moved.raw } };
    },
    async edit(ticketKey, { title, description }) {
      if (title === undefined && description === undefined) {
        throw new PortError('ticketSource', 'edit', 'invalid', 'an edit names a title, a description, or both');
      }
      const { node } = await lookup('edit', ticketKey);
      const input = {
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
      };
      const data = await client.request<{
        issueUpdate: { success: boolean; issue: { id: string; identifier: string; url: string } | null };
      }>('edit', 'SailEdit', EDIT, { id: node.id, input });
      if (!data.issueUpdate.success || data.issueUpdate.issue === null) {
        throw new PortError('ticketSource', 'edit', 'conflict', `Linear did not edit ${ticketKey}`, data);
      }
      emit({ type: 'ticket:edited', ticketKey, fields: Object.keys(input) as ('title' | 'description')[] });
      return { ticketKey, url: data.issueUpdate.issue.url, raw: data };
    },
    async attach(ticketKey, file) {
      checkAttachment(file);
      const { node } = await lookup('attach', ticketKey);
      const { name, contentType, bytes } = file;
      const uploaded = await client.request<{
        fileUpload: {
          success: boolean;
          uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] } | null;
        };
      }>('attach', 'SailUpload', UPLOAD, { contentType, filename: name, size: bytes.byteLength });
      if (!uploaded.fileUpload.success || uploaded.fileUpload.uploadFile === null) {
        throw new PortError('ticketSource', 'attach', 'conflict', `Linear gave no upload URL for ${name}`, uploaded);
      }
      const { uploadUrl, assetUrl, headers } = uploaded.fileUpload.uploadFile;
      await put(
        uploadUrl,
        {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000',
          ...Object.fromEntries(headers.map(({ key, value }) => [key, value])),
        },
        bytes,
      );
      const title = file.title ?? name;
      const data = await client.request<{
        attachmentCreate: { success: boolean; attachment: { id: string; url: string } | null };
      }>('attach', 'SailAttach', ATTACH, { issueId: node.id, url: assetUrl, title });
      if (!data.attachmentCreate.success || data.attachmentCreate.attachment === null) {
        throw new PortError(
          'ticketSource',
          'attach',
          'conflict',
          `Linear did not attach ${name} to ${ticketKey}`,
          data,
        );
      }
      const { url } = data.attachmentCreate.attachment;
      emit({ type: 'ticket:attached', ticketKey, name: title, contentType, size: bytes.byteLength, url });
      return { url, raw: data };
    },
    capabilities: () => ({
      comments: true,
      links: true,
      attachments: true,
      moves: [
        'unstarted',
        'in-progress',
        ...(inReview === undefined ? [] : (['in-review'] as const)),
        'done',
        'canceled',
      ],
    }),
  };

  /** Throws naming the first `pickUp` entry that is no triage, backlog or unstarted state of the team. */
  async function checkPickUp(): Promise<void> {
    for (const name of pickUp ?? []) {
      const found = (await states('configure')).find((state) => state.name === name);
      if (found === undefined) {
        throw new Error(`linear ticketSource: option pickUp: '${name}' is no state of team ${team}`);
      }
      if (!UNSTARTED_TYPES.includes(found.type)) {
        throw new Error(
          `linear ticketSource: option pickUp: '${name}' is a ${found.type} state of team ${team}; pickUp takes triage, backlog and unstarted states`,
        );
      }
    }
  }

  return { source, checkPickUp };
}

export function createLinearTicketSource(options: LinearTicketSourceOptions): TicketSource {
  return buildLinearTicketSource(options).source;
}

/** The adapter, after its `pickUp` entries were checked against the team's states: one request, and none without `pickUp`. */
export async function openLinearTicketSource(options: LinearTicketSourceOptions): Promise<TicketSource> {
  const { source, checkPickUp } = buildLinearTicketSource(options);
  if (options.pickUp !== undefined) await checkPickUp();
  return source;
}

const LinearOptions = z.strictObject({
  team: z.string().regex(/^[A-Z][A-Z0-9]*$/, 'must be a Linear team key, such as ADW'),
  inReview: z.string().min(1).optional(),
  pickUp: z
    .array(z.string().min(1))
    .min(1)
    .refine((names) => new Set(names).size === names.length, 'names a state twice')
    .optional(),
});

/**
 * `linear` in `project.yaml`: `team` is required, `inReview` and `pickUp` optional, and the key comes from
 * `LINEAR_API_KEY`. With `pickUp`, creating it reads the team's states once to check the names.
 */
export const linearTicketSource: AdapterDefinition<TicketSource> = {
  requires: () => ['LINEAR_API_KEY'],
  create(options, context) {
    const parsed = LinearOptions.safeParse(options);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const option = issue?.code === 'unrecognized_keys' ? issue.keys.join(', ') : issue?.path.join('.');
      throw new Error(`linear ticketSource: option ${option}: ${issue?.message}`);
    }
    return openLinearTicketSource({
      team: parsed.data.team,
      ...(parsed.data.inReview === undefined ? {} : { inReview: parsed.data.inReview }),
      ...(parsed.data.pickUp === undefined ? {} : { pickUp: parsed.data.pickUp }),
      apiKey: context.env.LINEAR_API_KEY ?? '',
      endpoint: context.env.SAIL_LINEAR_API_URL || LINEAR_ENDPOINT,
      ...(context.emit === undefined ? {} : { emit: context.emit }),
      ...(context.now === undefined ? {} : { now: context.now }),
    });
  },
};
