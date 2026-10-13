// The scripted Linear world's own semantics, proved before any adapter code uses it.
import { expect, test } from 'bun:test';
import { createLinearWorld, type WorldIssue } from './linear-world';

const FETCH_ISSUE = `query FetchIssue($team: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }) { nodes { id identifier } }
}`;
const FETCH_MORE = `query FetchMoreComments($id: String!, $after: String!) {
  issue(id: $id) { comments(first: 100, after: $after) { nodes { body } pageInfo { hasNextPage endCursor } } }
}`;
const LIST = `query ListIssues($team: String!, $label: String!, $first: Int!, $after: String) {
  issues(first: $first, after: $after) { nodes { identifier } pageInfo { hasNextPage endCursor } }
}`;
const STATES = `query TeamWorkflowStates($team: String!) {
  teams(filter: { key: { eq: $team } }) { nodes { states { nodes { id name type position } } } }
}`;
const UPDATE = `mutation UpdateIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { state { id name type } } }
}`;
const COMMENT = `mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id url } }
}`;

/** One POST of `query` with `variables` through the world's transport, as the adapter sends it. */
async function post(world: ReturnType<typeof createLinearWorld>, query: string, variables: object, headers = {}) {
  const response = await world.transport('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// biome-ignore lint/suspicious/noExplicitAny: the answers are read by shape in each test
const data = (answer: { body: Record<string, unknown> }) => answer.body.data as Record<string, any>;

const issue = (identifier: string, state: string, extra: Partial<WorldIssue> = {}): WorldIssue => ({
  identifier,
  title: `Ticket ${identifier}`,
  state,
  labels: ['sail'],
  ...extra,
});

test('the default world holds the ADW team states, each with its type and position', async () => {
  const world = createLinearWorld();
  const answer = await post(world, STATES, { team: 'ADW' });
  const states = data(answer).teams.nodes[0].states.nodes as { name: string; type: string; position: number }[];
  expect(states.map(({ name, type, position }) => [name, type, position])).toEqual([
    ['Backlog', 'backlog', 0],
    ['Todo', 'unstarted', 1],
    ['In Progress', 'started', 2],
    ['In Review', 'started', 3],
    ['Done', 'completed', 4],
    ['Canceled', 'canceled', 5],
    ['Duplicate', 'duplicate', 6],
  ]);
});

test('an UpdateIssue changes the state a later FetchIssue reads, and the world reports it', async () => {
  const world = createLinearWorld({ issues: [issue('ADW-1', 'Todo')] });
  const before = data(await post(world, FETCH_ISSUE, { team: 'ADW', number: 1 })).issues.nodes[0];
  const states = data(await post(world, STATES, { team: 'ADW' })).teams.nodes[0].states.nodes;
  const inProgress = states.find((state: { name: string }) => state.name === 'In Progress');
  const moved = await post(world, UPDATE, { id: before.id, stateId: inProgress.id });
  expect(data(moved).issueUpdate).toEqual({ success: true, issue: { state: inProgress } });
  expect(world.stateOf('ADW-1')).toEqual({ type: 'started', name: 'In Progress' });
  const after = data(await post(world, FETCH_ISSUE, { team: 'ADW', number: 1 })).issues.nodes[0];
  expect(after.identifier).toBe('ADW-1');
  expect(world.stateOf('ADW-1').name).toBe('In Progress');
});

test('a CreateComment adds a comment that a later read returns, and reports its id and URL', async () => {
  const world = createLinearWorld({ issues: [issue('ADW-1', 'Todo', { comments: [{ body: 'First.' }] })] });
  const id = data(await post(world, FETCH_ISSUE, { team: 'ADW', number: 1 })).issues.nodes[0].id;
  const created = data(await post(world, COMMENT, { issueId: id, body: 'Run started.' })).commentCreate;
  expect(created.success).toBe(true);
  const posted = world.comments('ADW-1').at(-1);
  expect({ id: created.comment.id, url: created.comment.url }).toEqual({ id: posted?.id, url: posted?.url });
  expect(world.comments('ADW-1').map((comment) => comment.body)).toEqual(['First.', 'Run started.']);
});

test('every request is recorded with its URL, its lower-case headers, its operation and its variables', async () => {
  const world = createLinearWorld({ issues: [issue('ADW-1', 'Todo')] });
  await post(world, FETCH_ISSUE, { team: 'ADW', number: 1 }, { Authorization: 'lin_api_recorded-key' });
  expect(world.requests).toEqual([
    {
      url: 'https://api.linear.app/graphql',
      headers: { 'content-type': 'application/json', authorization: 'lin_api_recorded-key' },
      operation: 'FetchIssue',
      variables: { team: 'ADW', number: 1 },
    },
  ]);
});

test('an injected HTTP status answers the next request, once, and the request after it is answered normally', async () => {
  const world = createLinearWorld({ issues: [issue('ADW-1', 'Todo')] });
  world.injectFailure({ status: 503 });
  expect((await post(world, FETCH_ISSUE, { team: 'ADW', number: 1 })).status).toBe(503);
  const next = await post(world, FETCH_ISSUE, { team: 'ADW', number: 1 });
  expect([next.status, data(next).issues.nodes.length]).toEqual([200, 1]);
});

test('an injected GraphQL error comes on a 200 with data null and the extensions code, for the named operation only', async () => {
  const world = createLinearWorld({ issues: [issue('ADW-1', 'Todo')] });
  world.injectFailure({ errors: [{ message: 'Rate limit exceeded', code: 'RATELIMITED' }] }, 'UpdateIssue');
  const read = await post(world, FETCH_ISSUE, { team: 'ADW', number: 1 });
  expect(read.body.data).not.toBeNull();
  const answer = await post(world, UPDATE, { id: 'issue-1', stateId: 'state-todo' });
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual({
    data: null,
    errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }],
  });
});

test('an injected network failure rejects the request with the injected error', async () => {
  const world = createLinearWorld();
  world.injectFailure({ reject: new TypeError('fetch failed') });
  await expect(post(world, FETCH_ISSUE, { team: 'ADW', number: 1 })).rejects.toThrow('fetch failed');
});

test('ListIssues and FetchMoreComments page with cursors, at the page size the world is given', async () => {
  const comments = ['one', 'two', 'three', 'four', 'five'].map((body) => ({ body }));
  const world = createLinearWorld({
    pageSize: 2,
    issues: [issue('ADW-1', 'Todo', { comments }), issue('ADW-2', 'Backlog'), issue('ADW-3', 'Todo')],
  });
  const first = data(await post(world, FETCH_ISSUE, { team: 'ADW', number: 1 })).issues.nodes[0];
  expect(first.identifier).toBe('ADW-1');

  // Every page comes through FetchMoreComments, each from the cursor the last one gave.
  const read: string[] = [];
  let page = { nodes: [] as { body: string }[], pageInfo: { hasNextPage: true, endCursor: 'offset:0' } };
  while (page.pageInfo.hasNextPage) {
    const answer = await post(world, FETCH_MORE, { id: first.id, after: page.pageInfo.endCursor });
    page = data(answer).issue.comments;
    read.push(...page.nodes.map((node) => node.body));
  }
  expect(read).toEqual(['one', 'two', 'three', 'four', 'five']);

  const listedAll: string[] = [];
  let after: string | undefined;
  let more = true;
  while (more) {
    const listed = data(await post(world, LIST, { team: 'ADW', label: 'sail', first: 100, after })).issues;
    listedAll.push(...listed.nodes.map((node: { identifier: string }) => node.identifier));
    more = listed.pageInfo.hasNextPage;
    after = listed.pageInfo.endCursor;
  }
  expect(listedAll).toEqual(['ADW-1', 'ADW-2', 'ADW-3']);
  const shorter = data(await post(world, LIST, { team: 'ADW', label: 'sail', first: 1 })).issues;
  expect([shorter.nodes.length, shorter.pageInfo.hasNextPage]).toEqual([1, true]);
});
