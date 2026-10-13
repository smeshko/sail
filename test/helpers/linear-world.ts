// A scripted Linear world: an in-memory stand-in for the GraphQL API the Linear ticket source talks to, so the adapter's
// tests run with no network and no key. It answers the six operations the adapter sends, routed by the operation name
// in each document, in the wire shape ADW's Linear client reads. That proves the adapter against that shape, not against
// Linear itself: TASK-009's opt-in live run is the only proof against the service.
//
// The contract the adapter follows (variables in, `data` out):
//   FetchIssue          { team, number }                -> data.issues.nodes: [issue], empty when there is none
//   FetchMoreComments   { id, after }                   -> data.issue.comments: { nodes, pageInfo }
//   ListIssues          { team, label, first, after }   -> data.issues: { nodes, pageInfo }
//   TeamWorkflowStates  { team }                        -> data.teams.nodes: [{ states: { nodes } }]
//   UpdateIssue         { id, stateId }                 -> data.issueUpdate: { success, issue: { state } }
//   CreateComment       { issueId, body }               -> data.commentCreate: { success, comment: { id, url } }
//
// Every name, e-mail and ticket here is invented: tickets are sail's own ADW-<n>, and the users are fictional.

export interface WorldState {
  id: string;
  name: string;
  /** Linear's state type: backlog, unstarted, started, completed, canceled or duplicate. */
  type: string;
  position: number;
}

export interface WorldIssue {
  identifier: string;
  title: string;
  /** Left out or null: the issue has no description. */
  description?: string | null;
  /** The name of one of the team's states. */
  state: string;
  labels?: string[];
  /** Left out author: the comment is by `fixture-user`. `null`: a comment with no user. */
  comments?: { body: string; author?: string | null }[];
  relations?: { type: string; identifier: string; title: string }[];
  attachments?: { title: string; url: string }[];
  priority?: number;
  assignee?: string | null;
}

export interface LinearWorldOptions {
  /** The team key. Default `ADW`. */
  team?: string;
  /** The team's states. Default: the ADW team's own. */
  states?: readonly WorldState[];
  issues?: readonly WorldIssue[];
  /** The most nodes one answer holds, and the page a request gets when it asks for more. Default 100. */
  pageSize?: number;
}

export interface WorldRequest {
  url: string;
  /** Header names in lower case, as `Headers` gives them. */
  headers: Record<string, string>;
  operation: string;
  variables: Record<string, unknown>;
}

/** An answer to inject: an HTTP status with an optional body, GraphQL `errors` on a 200, or a thrown fetch failure. */
export type Injected =
  | { status: number; body?: unknown }
  | { errors: { message: string; code?: string }[] }
  | { reject: unknown };

export interface WorldComment {
  id: string;
  url: string;
  body: string;
  author: string | null;
}

export interface LinearWorld {
  /** A `fetch` the adapter can be handed, or install as `globalThis.fetch`. */
  readonly transport: typeof fetch;
  /** Every request made through `transport`, in order. */
  readonly requests: WorldRequest[];
  /**
   * Makes the next request, or the next one with `operation`, answer `answer` instead. A queued answer is used once.
   */
  injectFailure(answer: Injected, operation?: string): void;
  /** The state of an issue, as a read of it now would give. */
  stateOf(identifier: string): { type: string; name: string };
  /** An issue's comments now, in order. */
  comments(identifier: string): WorldComment[];
}

/** The ADW team's states, with the types and positions the team has. */
export const ADW_STATES: readonly WorldState[] = [
  { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 'state-todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 'state-in-progress', name: 'In Progress', type: 'started', position: 2 },
  { id: 'state-in-review', name: 'In Review', type: 'started', position: 3 },
  { id: 'state-done', name: 'Done', type: 'completed', position: 4 },
  { id: 'state-canceled', name: 'Canceled', type: 'canceled', position: 5 },
  { id: 'state-duplicate', name: 'Duplicate', type: 'duplicate', position: 6 },
];

const OPERATION = /\b(?:query|mutation)\s+([A-Za-z_]\w*)/;
const URL_BASE = 'https://linear.app/sail-fixture/issue';
const CREATED_AT = '2026-10-02T09:00:00.000Z';

const issueUrl = (identifier: string): string => `${URL_BASE}/${identifier}`;
const cursorAt = (offset: number): string => `offset:${offset}`;
const offsetOf = (cursor: unknown): number =>
  typeof cursor === 'string' && cursor.startsWith('offset:') ? Number(cursor.slice('offset:'.length)) : 0;

/** One page of `items` from the cursor `after`, with the page info Linear gives. */
function pageOf<T>(items: readonly T[], after: unknown, length: number) {
  const start = offsetOf(after);
  const end = start + length;
  return { nodes: items.slice(start, end), pageInfo: { hasNextPage: end < items.length, endCursor: cursorAt(end) } };
}

interface StoredComment {
  id: string;
  body: string;
  author: string | null;
}

interface StoredIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: WorldState;
  labels: string[];
  comments: StoredComment[];
  relations: NonNullable<WorldIssue['relations']>;
  attachments: NonNullable<WorldIssue['attachments']>;
  priority: number;
  assignee: string | null;
}

/** What the world answers: an HTTP status and the JSON body it sends. */
interface Outcome {
  status: number;
  body: unknown;
}

/** An injected answer as the wire shows it: GraphQL `errors` come on a 200 with `data` null. */
function injectedOutcome(injected: Exclude<Injected, { reject: unknown }>): Outcome {
  if (!('errors' in injected)) return { status: injected.status, body: injected.body ?? {} };
  const errors = injected.errors.map((error) => ({
    message: error.message,
    ...(error.code === undefined ? {} : { extensions: { code: error.code } }),
  }));
  return { status: 200, body: { data: null, errors } };
}

export function createLinearWorld(options: LinearWorldOptions = {}): LinearWorld {
  const team = options.team ?? 'ADW';
  const pageSize = options.pageSize ?? 100;
  const states: WorldState[] = [...(options.states ?? ADW_STATES)];
  let counter = 0;
  const nextId = (prefix: string): string => `${prefix}-${++counter}`;

  const stateNamed = (name: string): WorldState => {
    const found = states.find((state) => state.name === name);
    if (found === undefined) throw new Error(`the world has no state named ${name}`);
    return found;
  };
  const issues: StoredIssue[] = (options.issues ?? []).map((issue) => ({
    id: nextId('issue'),
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    state: stateNamed(issue.state),
    labels: [...(issue.labels ?? [])],
    comments: (issue.comments ?? []).map((comment) => ({
      id: nextId('comment'),
      body: comment.body,
      author: comment.author === undefined ? 'fixture-user' : comment.author,
    })),
    relations: [...(issue.relations ?? [])],
    attachments: [...(issue.attachments ?? [])],
    priority: issue.priority ?? 0,
    assignee: issue.assignee ?? null,
  }));
  const byIdentifier = (identifier: string) => issues.find((issue) => issue.identifier === identifier);
  const byId = (id: string) => issues.find((issue) => issue.id === id);

  const commentNode = (comment: StoredComment) => ({
    id: comment.id,
    body: comment.body,
    createdAt: CREATED_AT,
    user: comment.author === null ? null : { name: comment.author },
  });
  const issueNode = (issue: StoredIssue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issueUrl(issue.identifier),
    priority: issue.priority,
    state: { ...issue.state },
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    assignee: issue.assignee === null ? null : { name: issue.assignee },
    comments: pageOf(issue.comments.map(commentNode), undefined, pageSize),
    relations: {
      nodes: issue.relations.map((relation) => ({
        type: relation.type,
        relatedIssue: { identifier: relation.identifier, title: relation.title, url: issueUrl(relation.identifier) },
      })),
    },
    attachments: { nodes: issue.attachments.map(({ title, url }) => ({ title, url })) },
  });
  /** The length a page asks for: its `first`, never more than the world's page size. */
  const lengthFor = (first: unknown): number => (typeof first === 'number' ? Math.min(first, pageSize) : pageSize);
  const ok = (data: unknown): Outcome => ({ status: 200, body: { data } });

  const answer = (operation: string, variables: Record<string, unknown>): Outcome => {
    switch (operation) {
      case 'FetchIssue': {
        const identifier = `${String(variables.team)}-${String(variables.number)}`;
        const found = variables.team === team ? byIdentifier(identifier) : undefined;
        return ok({ issues: { nodes: found === undefined ? [] : [issueNode(found)] } });
      }
      case 'FetchMoreComments': {
        const found = byId(String(variables.id));
        if (found === undefined) return ok({ issue: null });
        return ok({ issue: { comments: pageOf(found.comments.map(commentNode), variables.after, pageSize) } });
      }
      case 'ListIssues': {
        const matching = issues.filter(
          (issue) =>
            variables.team === team &&
            issue.identifier.startsWith(`${team}-`) &&
            issue.labels.includes(String(variables.label)) &&
            (issue.state.type === 'backlog' || issue.state.type === 'unstarted'),
        );
        return ok({ issues: pageOf(matching.map(issueNode), variables.after, lengthFor(variables.first)) });
      }
      case 'TeamWorkflowStates':
        return ok({
          teams: {
            nodes: variables.team === team ? [{ states: { nodes: states.map((state) => ({ ...state })) } }] : [],
          },
        });
      case 'UpdateIssue': {
        const found = byId(String(variables.id));
        const next = states.find((state) => state.id === variables.stateId);
        if (found === undefined || next === undefined) return ok({ issueUpdate: { success: false, issue: null } });
        found.state = next;
        return ok({ issueUpdate: { success: true, issue: { state: { ...next } } } });
      }
      case 'CreateComment': {
        const found = byId(String(variables.issueId));
        if (found === undefined) return ok({ commentCreate: { success: false, comment: null } });
        const comment: StoredComment = { id: nextId('comment'), body: String(variables.body), author: 'sail' };
        found.comments.push(comment);
        const url = `${issueUrl(found.identifier)}#${comment.id}`;
        return ok({ commentCreate: { success: true, comment: { id: comment.id, url } } });
      }
      default:
        return { status: 400, body: { errors: [{ message: `the world has no operation ${operation}` }] } };
    }
  };

  const requests: WorldRequest[] = [];
  const queue: { answer: Injected; operation: string | undefined }[] = [];

  const transport = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as {
      query?: unknown;
      variables?: unknown;
    };
    const operation = OPERATION.exec(String(body.query ?? ''))?.[1] ?? '';
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    requests.push({ url, headers, operation, variables });

    const at = queue.findIndex((item) => item.operation === undefined || item.operation === operation);
    const [injection] = at === -1 ? [] : queue.splice(at, 1);
    if (injection !== undefined && 'reject' in injection.answer) throw injection.answer.reject;
    const outcome =
      injection === undefined
        ? answer(operation, variables)
        : injectedOutcome(injection.answer as Exclude<Injected, { reject: unknown }>);
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    transport: transport as unknown as typeof fetch,
    requests,
    injectFailure: (answer, operation) => {
      queue.push({ answer, operation });
    },
    stateOf: (identifier) => {
      const found = byIdentifier(identifier);
      if (found === undefined) throw new Error(`the world has no issue ${identifier}`);
      return { type: found.state.type, name: found.state.name };
    },
    comments: (identifier) =>
      (byIdentifier(identifier)?.comments ?? []).map((comment) => ({
        id: comment.id,
        url: `${issueUrl(identifier)}#${comment.id}`,
        body: comment.body,
        author: comment.author,
      })),
  };
}
