// createLinearWorld(): a scripted Linear for the linear TicketSource's tests. One team with its workflow states and labels, and its
// tickets with labels, comments, relations and attachments, answering the adapter's GraphQL operations by
// `operationName` and `variables`, either as an injected `fetch` or served on 127.0.0.1 for the CLI. It stands in for
// Linear's file storage too: `fileUpload` signs an upload URL, and a PUT to it is taken only with the headers, content
// type and size it was signed for, as `upload` in `requests`.
//
// It reads no filter out of the query: the filters it honours arrive as variables. What it does check of the query is
// cheap and catches a typo, not a wrong shape: the query declares the operation it is sent as, declares every variable
// it is sent with, and names only fields and arguments that Linear's schema has (`LINEAR_NAMES`, from Linear's published
// schema). An operation it doesn't know, a query that fails a check, or a key it wasn't given answers as Linear would,
// with an error. The live suite is what proves the documents against Linear itself.

/** A workflow state of the team. */
export interface WorldState {
  readonly id: string;
  readonly name: string;
  /** Linear's state type: triage, backlog, unstarted, started, completed, canceled or duplicate. */
  readonly type: string;
  readonly position: number;
}

export interface WorldComment {
  readonly body: string;
  readonly createdAt: string;
  /** The author's name. `null` for a comment no user wrote. */
  readonly user?: string | null;
  /** The bot that wrote the comment, when one did. */
  readonly bot?: string;
}

export interface WorldTicket {
  readonly number: number;
  title: string;
  /** Linear sends `null` for a ticket without one. */
  description?: string | null;
  /** The state's name. */
  state: string;
  labels?: readonly string[];
  comments?: WorldComment[];
  /** This ticket's relations to other tickets of the world, by number. Their inverse is derived. */
  relations?: readonly { readonly type: string; readonly number: number }[];
  attachments?: readonly { readonly title: string; readonly url: string }[];
  readonly priority?: number;
  readonly assignee?: { readonly name: string; readonly email: string } | null;
}

/** An issue label the team can apply. */
export interface WorldLabel {
  readonly id: string;
  readonly name: string;
}

export interface LinearWorldSeed {
  readonly team: {
    readonly key: string;
    readonly states: readonly WorldState[];
    /** The labels its tickets can carry, the team's own and the workspace's alike. None unless given. */
    readonly labels?: readonly WorldLabel[];
  };
  readonly tickets: readonly WorldTicket[];
  /** The most nodes a page holds, whatever `first` asks for. 250 unless given. */
  readonly pageSize?: number;
  /** The API key the world accepts. Any other answers 401 with `AUTHENTICATION_ERROR`. Any key unless given. */
  readonly apiKey?: string;
}

/** A canned answer for failure injection. */
export interface WorldResponse {
  readonly status: number;
  /** Sent as JSON, or as it is when a string. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface WorldRequest {
  readonly method: string;
  readonly operationName: string;
  readonly query: string;
  readonly variables: Record<string, unknown>;
  /** The request's headers, names in lower case. */
  readonly headers: Record<string, string>;
}

/** A file the world's storage took: the PUT's URL, headers and bytes. */
export interface WorldUpload {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly bytes: Uint8Array;
}

export interface LinearWorld {
  /** Answers one request as Linear would: inject it as the adapter's `fetch`. */
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Serves the world on 127.0.0.1 at a free port. */
  serve(): { url: string; stop(): void };
  /** Every request the world received, in order. */
  readonly requests: WorldRequest[];
  /** The files the world's storage took, in order. */
  readonly uploads: WorldUpload[];
  /** The operation names of the requests, in order. */
  operations(): string[];
  /**
   * Answers the next request of `operationName` with `response`, once: the first one, or the first after a request of
   * `options.after` has been answered.
   */
  failNext(operationName: string, response: WorldResponse, options?: { readonly after?: string }): void;
  /** A ticket as the world holds it now. Throws for a number it doesn't hold. */
  ticket(number: number): WorldTicket;
}

/** The workspace in every ticket URL. */
export const WORLD_WORKSPACE = 'sail-test';

/** The names Linear's schema has that the adapter's documents may use: fields, arguments, filter keys and types. */
export const LINEAR_NAMES: ReadonlySet<string> = new Set([
  // Operations and scalar types.
  'query',
  'mutation',
  'String',
  'Float',
  'Int',
  'Boolean',
  'ID',
  'IssueRelationType',
  'IssueUpdateInput',
  // Query and mutation roots.
  'issues',
  'issue',
  'teams',
  'issueUpdate',
  'commentCreate',
  'issueCreate',
  'issueAddLabel',
  'issueRemoveLabel',
  'issueRelationCreate',
  'issueLabels',
  'fileUpload',
  'attachmentCreate',
  // Arguments and filters.
  'filter',
  'first',
  'after',
  'input',
  'eq',
  'in',
  'some',
  'or',
  'null',
  'true',
  'stateId',
  'issueId',
  'teamId',
  'labelIds',
  'labelId',
  'relatedIssueId',
  'contentType',
  'filename',
  'size',
  // Connections.
  'nodes',
  'pageInfo',
  'hasNextPage',
  'endCursor',
  // Issue.
  'id',
  'identifier',
  'number',
  'title',
  'description',
  'url',
  'priority',
  'state',
  'team',
  'assignee',
  'labels',
  'comments',
  'relations',
  'inverseRelations',
  'attachments',
  'relatedIssue',
  'type',
  'name',
  'email',
  'key',
  'position',
  'states',
  // Comment.
  'body',
  'createdAt',
  'user',
  'botActor',
  // Mutation payloads.
  'success',
  'comment',
  'attachment',
  'issueRelation',
  'uploadFile',
  'uploadUrl',
  'assetUrl',
  'headers',
  'value',
]);

const MUTATIONS = new Set([
  'SailMove',
  'SailComment',
  'SailCreate',
  'SailUpload',
  'SailAttach',
  'SailAddLabel',
  'SailRemoveLabel',
  'SailRelate',
  'SailEdit',
]);

/** The header `fileUpload` signs an upload with, which the PUT must carry back. */
export const UPLOAD_SIGNATURE = 'x-sail-signature';

/** Where an injected `fetch` finds the world's storage. `serve()` serves it beside the GraphQL endpoint instead. */
const STORAGE = 'https://uploads.linear.test';

/** Linear's answer to a GraphQL error: status 400 and one error with its code. */
const graphqlError = (status: number, code: string, message: string): WorldResponse => ({
  status,
  body: { errors: [{ message, extensions: { code, userPresentableMessage: message } }] },
});

/** What is wrong with `query` sent as `operationName` with `variables`, or undefined when nothing is. */
function queryProblem(operationName: string, query: string, variables: Record<string, unknown>): string | undefined {
  const kind = MUTATIONS.has(operationName) ? 'mutation' : 'query';
  const head = new RegExp(`^\\s*${kind}\\s+${operationName}\\s*[({]`);
  if (!head.test(query)) return `the document is no ${kind} named ${operationName}`;
  for (const name of Object.keys(variables)) {
    if (!new RegExp(`\\$${name}\\s*:`).test(query))
      return `Variable "$${name}" is not defined by operation "${operationName}"`;
  }
  const names =
    query
      .replace(/\$\w+/g, ' ')
      .replace(/"[^"]*"/g, ' ')
      .match(/[A-Za-z_]\w*/g) ?? [];
  const unknown = names.find((name) => name !== operationName && !LINEAR_NAMES.has(name));
  return unknown === undefined ? undefined : `Cannot query field "${unknown}"`;
}

export function createLinearWorld(seed: LinearWorldSeed): LinearWorld {
  const team = {
    key: seed.team.key,
    states: seed.team.states.map((state) => ({ ...state })),
    labels: (seed.team.labels ?? []).map((label) => ({ ...label })),
  };
  const tickets: WorldTicket[] = seed.tickets.map((ticket) => ({
    ...ticket,
    comments: (ticket.comments ?? []).map((comment) => ({ ...comment })),
  }));
  const pageSize = seed.pageSize ?? 250;
  const requests: WorldRequest[] = [];
  const uploads: WorldUpload[] = [];
  /** Each signed upload by its number: what its PUT must carry. */
  const signed = new Map<string, { contentType: string; size: number; filename: string }>();
  let storage = STORAGE;
  const failures: { operationName: string; after: string | undefined; response: WorldResponse }[] = [];
  let posted = 0;

  const identifier = (number: number) => `${team.key}-${number}`;
  const urlOf = (number: number) => `https://linear.app/${WORLD_WORKSPACE}/issue/${identifier(number)}`;
  const find = (number: number): WorldTicket => {
    const ticket = tickets.find((candidate) => candidate.number === number);
    if (ticket === undefined) throw new Error(`the Linear world holds no ticket ${number}`);
    return ticket;
  };
  const byId = (id: unknown) => tickets.find((ticket) => `issue-${ticket.number}` === id);
  const stateOf = (ticket: WorldTicket): WorldState => {
    const state = team.states.find((candidate) => candidate.name === ticket.state);
    if (state === undefined) throw new Error(`the Linear world has no state ${ticket.state}`);
    return state;
  };
  const related = (number: number) => ({
    identifier: identifier(number),
    title: find(number).title,
    url: urlOf(number),
  });

  /** `items` from the cursor `after`, at most `first` of them and a page. */
  function page<T>(items: readonly T[], first: unknown, after: unknown) {
    const start = typeof after === 'string' ? Number(after) + 1 : 0;
    const size = Math.min(typeof first === 'number' ? first : 250, pageSize);
    const nodes = items.slice(start, start + size);
    const end = start + nodes.length - 1;
    return {
      nodes,
      pageInfo: { hasNextPage: end < items.length - 1, endCursor: nodes.length > 0 ? String(end) : null },
    };
  }

  const commentNode = (comment: WorldComment, index: number) => ({
    id: `comment-${index + 1}`,
    body: comment.body,
    createdAt: comment.createdAt,
    user: comment.user == null ? null : { name: comment.user },
    botActor: comment.bot === undefined ? null : { name: comment.bot },
  });

  /** The ticket's node with every field the adapter selects, its comments to one page. */
  function node(ticket: WorldTicket) {
    const state = stateOf(ticket);
    const inverse = tickets.flatMap((other) =>
      (other.relations ?? [])
        .filter((relation) => relation.number === ticket.number)
        .map((relation) => {
          const { name, type } = stateOf(other);
          return { type: relation.type, issue: { ...related(other.number), state: { name, type } } };
        }),
    );
    return {
      id: `issue-${ticket.number}`,
      identifier: identifier(ticket.number),
      number: ticket.number,
      title: ticket.title,
      description: ticket.description === undefined ? '' : ticket.description,
      url: urlOf(ticket.number),
      priority: ticket.priority ?? 0,
      state: { id: state.id, name: state.name, type: state.type },
      team: { key: team.key },
      assignee: ticket.assignee ?? null,
      labels: { nodes: (ticket.labels ?? []).map((name) => ({ name })) },
      comments: page((ticket.comments ?? []).map(commentNode), 250, undefined),
      relations: {
        nodes: (ticket.relations ?? []).map((relation) => ({
          type: relation.type,
          relatedIssue: related(relation.number),
        })),
      },
      inverseRelations: { nodes: inverse },
      attachments: { nodes: (ticket.attachments ?? []).map((attachment) => ({ ...attachment })) },
    };
  }

  const ok = (data: unknown): WorldResponse => ({ status: 200, body: { data } });

  /** Adds or removes a label of the team, as Linear's issueAddLabel and issueRemoveLabel do. */
  function relabel(field: string, id: unknown, labelId: unknown, adding: boolean): WorldResponse {
    const ticket = byId(id);
    const label = team.labels.find((candidate) => candidate.id === labelId);
    if (ticket === undefined || label === undefined) {
      return graphqlError(400, 'INPUT_ERROR', `Entity not found: ${ticket === undefined ? 'Issue' : 'IssueLabel'}`);
    }
    const others = (ticket.labels ?? []).filter((name) => name !== label.name);
    ticket.labels = adding ? [...others, label.name] : others;
    return ok({
      [field]: { success: true, issue: { labels: { nodes: ticket.labels.map((name) => ({ name })) } } },
    });
  }

  const OPERATIONS: Record<string, (variables: Record<string, unknown>) => WorldResponse> = {
    SailTicket: ({ team: key, number }) => {
      const found = key === team.key ? tickets.filter((ticket) => ticket.number === number) : [];
      return ok({ issues: { nodes: found.map(node) } });
    },
    SailTicketComments: ({ id, after }) => {
      const ticket = byId(id);
      if (ticket === undefined) return graphqlError(400, 'INPUT_ERROR', `Entity not found: Issue - ${String(id)}`);
      return ok({ issue: { comments: page((ticket.comments ?? []).map(commentNode), 250, after) } });
    },
    SailDesignated: ({ team: key, label, types, names, after }) => {
      const wanted = Array.isArray(types) ? types : [];
      const named = Array.isArray(names) ? names : undefined;
      const found =
        key === team.key
          ? tickets.filter(
              (ticket) =>
                (ticket.labels ?? []).includes(String(label)) &&
                wanted.includes(stateOf(ticket).type) &&
                (named === undefined || named.includes(stateOf(ticket).name)),
            )
          : [];
      return ok({ issues: page(found.map(node), 50, after) });
    },
    SailList: ({ team: key, label, types, after }) => {
      const wanted = Array.isArray(types) ? types : [];
      const found =
        key === team.key
          ? tickets.filter(
              (ticket) =>
                (label === undefined || (ticket.labels ?? []).includes(String(label))) &&
                wanted.includes(stateOf(ticket).type),
            )
          : [];
      return ok({ issues: page(found.map(node), 50, after) });
    },
    SailTeam: ({ team: key }) =>
      ok({
        teams: {
          nodes:
            key === team.key
              ? [
                  {
                    id: `team-${team.key}`,
                    key: team.key,
                    states: { nodes: team.states.map((state) => ({ ...state })) },
                  },
                ]
              : [],
        },
      }),
    SailTeamLabels: ({ team: key, after }) =>
      ok({
        teams: { nodes: key === team.key ? [{ id: `team-${team.key}` }] : [] },
        issueLabels: page(key === team.key ? team.labels.map((label) => ({ ...label })) : [], 250, after),
      }),
    SailCreate: ({ teamId, title, description, labelIds }) => {
      const ids = Array.isArray(labelIds) ? labelIds : [];
      const labels = ids.map((id) => team.labels.find((label) => label.id === id));
      if (teamId !== `team-${team.key}` || labels.includes(undefined)) {
        return graphqlError(
          400,
          'INPUT_ERROR',
          `Entity not found: ${teamId === `team-${team.key}` ? 'IssueLabel' : 'Team'}`,
        );
      }
      const number = Math.max(0, ...tickets.map((ticket) => ticket.number)) + 1;
      const [first] = team.states.filter((state) => state.type === 'unstarted').sort((a, b) => a.position - b.position);
      tickets.push({
        number,
        title: String(title),
        description: String(description),
        state: first?.name ?? '',
        labels: labels.map((label) => label?.name ?? ''),
        comments: [],
      });
      return ok({
        issueCreate: {
          success: true,
          issue: { id: `issue-${number}`, identifier: identifier(number), url: urlOf(number) },
        },
      });
    },
    SailAddLabel: ({ id, labelId }) => relabel('issueAddLabel', id, labelId, true),
    SailRemoveLabel: ({ id, labelId }) => relabel('issueRemoveLabel', id, labelId, false),
    SailRelate: ({ id, relatedId, type }) => {
      const ticket = byId(id);
      const other = byId(relatedId);
      if (ticket === undefined || other === undefined) {
        return graphqlError(400, 'INPUT_ERROR', `Entity not found: ${ticket === undefined ? 'Issue' : 'RelatedIssue'}`);
      }
      ticket.relations = [...(ticket.relations ?? []), { type: String(type), number: other.number }];
      return ok({
        issueRelationCreate: { success: true, issueRelation: { id: `relation-${ticket.relations.length}` } },
      });
    },
    SailEdit: ({ id, input }) => {
      const ticket = byId(id);
      if (ticket === undefined) return graphqlError(400, 'INPUT_ERROR', 'Entity not found: Issue');
      const change = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      if (typeof change.title === 'string') ticket.title = change.title;
      if (typeof change.description === 'string') ticket.description = change.description;
      return ok({
        issueUpdate: {
          success: true,
          issue: { id: `issue-${ticket.number}`, identifier: identifier(ticket.number), url: urlOf(ticket.number) },
        },
      });
    },
    SailUpload: ({ contentType, filename, size }) => {
      const number = String(signed.size + 1);
      signed.set(number, { contentType: String(contentType), size: Number(size), filename: String(filename) });
      const path = `${number}/${encodeURIComponent(String(filename))}`;
      return ok({
        fileUpload: {
          success: true,
          uploadFile: {
            uploadUrl: `${storage}/upload/${path}`,
            assetUrl: `${storage}/assets/${path}`,
            headers: [{ key: UPLOAD_SIGNATURE, value: `signed-${number}` }],
          },
        },
      });
    },
    SailAttach: ({ issueId, url, title }) => {
      const ticket = byId(issueId);
      if (ticket === undefined) return graphqlError(400, 'INPUT_ERROR', 'Entity not found: Issue');
      if (!uploads.some((upload) => upload.url.replace('/upload/', '/assets/') === url)) {
        return graphqlError(400, 'INPUT_ERROR', `no file was uploaded for ${String(url)}`);
      }
      ticket.attachments = [...(ticket.attachments ?? []), { title: String(title), url: String(url) }];
      const id = `attachment-${ticket.attachments.length}`;
      return ok({ attachmentCreate: { success: true, attachment: { id, url: String(url) } } });
    },
    SailMove: ({ id, stateId }) => {
      const ticket = byId(id);
      const state = team.states.find((candidate) => candidate.id === stateId);
      if (ticket === undefined || state === undefined) {
        return graphqlError(
          400,
          'INPUT_ERROR',
          `Entity not found: ${ticket === undefined ? 'Issue' : 'WorkflowState'}`,
        );
      }
      ticket.state = state.name;
      return ok({
        issueUpdate: { success: true, issue: { id, state: { id: state.id, name: state.name, type: state.type } } },
      });
    },
    SailComment: ({ id, body }) => {
      const ticket = byId(id);
      if (ticket === undefined) return graphqlError(400, 'INPUT_ERROR', 'Entity not found: Issue');
      posted++;
      const createdAt = new Date(Date.UTC(2026, 9, 14, 9, 0, posted)).toISOString();
      ticket.comments = [...(ticket.comments ?? []), { body: String(body), createdAt, user: 'sail' }];
      const commentId = `comment-${ticket.comments.length}`;
      return ok({
        commentCreate: { success: true, comment: { id: commentId, url: `${urlOf(ticket.number)}#${commentId}` } },
      });
    },
  };

  /**
   * A PUT to the storage: taken when it carries the signature, content type and size its upload was signed for, and
   * refused with 403 otherwise, as a signed URL is. A failure `failNext('upload', …)` set answers first.
   */
  function store(url: string, headers: Record<string, string>, bytes: Uint8Array): WorldResponse {
    requests.push({ method: 'PUT', operationName: 'upload', query: '', variables: { url }, headers });
    const failure = failures.find((candidate) => candidate.operationName === 'upload' && candidate.after === undefined);
    if (failure !== undefined) {
      failures.splice(failures.indexOf(failure), 1);
      return failure.response;
    }
    const number = /\/upload\/(\d+)\//.exec(url)?.[1] ?? '';
    const upload = signed.get(number);
    const fits =
      upload !== undefined &&
      headers[UPLOAD_SIGNATURE] === `signed-${number}` &&
      headers['content-type'] === upload.contentType &&
      bytes.byteLength === upload.size;
    if (!fits) return { status: 403, body: 'SignatureDoesNotMatch' };
    uploads.push({ url, headers, bytes });
    return { status: 200 };
  }

  function answer(method: string, headers: Record<string, string>, text: string): WorldResponse {
    let body: { query?: unknown; variables?: unknown; operationName?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return graphqlError(400, 'BAD_REQUEST', 'the body is not JSON');
    }
    const operationName = String(body.operationName ?? '');
    const query = String(body.query ?? '');
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    requests.push({ method, operationName, query, variables, headers });
    if (seed.apiKey !== undefined && headers.authorization !== seed.apiKey) {
      return graphqlError(401, 'AUTHENTICATION_ERROR', 'Authentication required, not authenticated');
    }
    const failure = failures.find(
      (candidate) => candidate.operationName === operationName && candidate.after === undefined,
    );
    if (failure !== undefined) {
      failures.splice(failures.indexOf(failure), 1);
      return failure.response;
    }
    for (const waiting of failures) if (waiting.after === operationName) waiting.after = undefined;
    const operation = OPERATIONS[operationName];
    if (operation === undefined) {
      return graphqlError(400, 'GRAPHQL_VALIDATION_FAILED', `Unknown operation named "${operationName}"`);
    }
    const problem = queryProblem(operationName, query, variables);
    if (problem !== undefined) return graphqlError(400, 'GRAPHQL_VALIDATION_FAILED', problem);
    return operation(variables);
  }

  const toResponse = (response: WorldResponse): Response =>
    new Response(
      response.body === undefined
        ? null
        : typeof response.body === 'string'
          ? response.body
          : JSON.stringify(response.body),
      {
        status: response.status,
        headers: {
          ...(typeof response.body === 'string' ? {} : { 'Content-Type': 'application/json' }),
          ...response.headers,
        },
      },
    );

  const headersOf = (init: Headers): Record<string, string> => Object.fromEntries(init.entries());

  return {
    async fetch(input, init) {
      const headers = headersOf(new Headers(init.headers));
      if (init.method === 'PUT') {
        const bytes = init.body instanceof Uint8Array ? init.body : new Uint8Array();
        return toResponse(store(input, headers, bytes));
      }
      const text = typeof init.body === 'string' ? init.body : '';
      return toResponse(answer(init.method ?? 'GET', headers, text));
    },
    serve() {
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: async (request) => {
          const headers = headersOf(request.headers);
          if (request.method === 'PUT') {
            return toResponse(store(request.url, headers, new Uint8Array(await request.arrayBuffer())));
          }
          return toResponse(answer(request.method, headers, await request.text()));
        },
      });
      storage = `http://127.0.0.1:${server.port}`;
      return { url: `http://127.0.0.1:${server.port}/graphql`, stop: () => server.stop(true) };
    },
    requests,
    uploads,
    operations: () => requests.map((request) => request.operationName),
    failNext(operationName, response, options = {}) {
      failures.push({ operationName, after: options.after, response });
    },
    ticket: find,
  };
}

/** Team `ADW` with Linear's default workflow states, under their default names. */
export const DEFAULT_STATES: readonly WorldState[] = [
  { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 'state-todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 'state-in-progress', name: 'In Progress', type: 'started', position: 2 },
  { id: 'state-in-review', name: 'In Review', type: 'started', position: 3 },
  { id: 'state-done', name: 'Done', type: 'completed', position: 4 },
  { id: 'state-canceled', name: 'Canceled', type: 'canceled', position: 5 },
  { id: 'state-duplicate', name: 'Duplicate', type: 'duplicate', position: 6 },
];

/** Seven states of every Linear type, none under its default name, the review state ahead of the work state. */
export const RENAMED_STATES: readonly WorldState[] = [
  { id: 'state-inbox', name: 'Inbox', type: 'triage', position: 0 },
  { id: 'state-icebox', name: 'Icebox', type: 'backlog', position: 1 },
  { id: 'state-ready', name: 'Ready', type: 'unstarted', position: 2 },
  { id: 'state-code-review', name: 'Code Review', type: 'started', position: 3 },
  { id: 'state-building', name: 'Building', type: 'started', position: 4 },
  { id: 'state-shipped', name: 'Shipped', type: 'completed', position: 5 },
  { id: 'state-dropped', name: 'Dropped', type: 'canceled', position: 6 },
];
