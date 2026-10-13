// Listing the designated tickets (TASK-004): backlog and unstarted only, paged, whatever the team calls its states, and
// the capabilities the adapter declares.
import { expect, test } from 'bun:test';
import { createLinearTicketSource } from '../../../../src/adapters/ticket-source/linear/index';
import { Ticket, TicketSourceCapabilities } from '../../../../src/ports/types';
import { ADW_STATES, createLinearWorld, type WorldIssue, type WorldState } from '../../../helpers/linear-world';
import { parseIssues } from '../../../helpers/ports';

const KEY = 'lin_api_SENTINEL-list-key';

const issue = (identifier: string, state: string, labels: string[] = ['sail']): WorldIssue => ({
  identifier,
  title: `Ticket ${identifier}`,
  state,
  labels,
});

const keysOf = (tickets: readonly { ticketKey: string }[]) => tickets.map((ticket) => ticket.ticketKey);

// Review fixes (review #1.3, #1.1): a listing that makes no progress is refused rather than looped over, and a listing
// asks for pages of ten tickets, so each page's comment requests stay under Linear's complexity cap.
/** A complete ticket node, as ListIssues answers one, with no comments. */
const ticketNode = {
  id: 'issue-1',
  identifier: 'ADW-1',
  title: 'Ticket ADW-1',
  description: null,
  url: 'https://linear.app/sail-fixture/issue/ADW-1',
  priority: 0,
  state: { id: 'state-todo', name: 'Todo', type: 'unstarted', position: 1 },
  labels: { nodes: [{ name: 'sail' }] },
  assignee: null,
  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  relations: { nodes: [] },
  attachments: { nodes: [] },
};

/**
 * A transport that answers every ListIssues with `page`. It stops after five calls, so a listing that loops fails the
 * test rather than hanging the run.
 */
function listingOf(page: unknown) {
  let calls = 0;
  return (async () => {
    calls += 1;
    if (calls > 5) throw new TypeError('the listing did not stop');
    return new Response(JSON.stringify({ data: { issues: page } }), { status: 200 });
  }) as unknown as typeof fetch;
}

test.each([
  ['an empty page that says there is more', { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'fresh' } }],
  ['a repeated cursor', { nodes: [ticketNode], pageInfo: { hasNextPage: true, endCursor: 'same' } }],
  ['a missing cursor', { nodes: [ticketNode], pageInfo: { hasNextPage: true } }],
])('a listing with %s is refused as invalid', async (_, page) => {
  const adapter = createLinearTicketSource({ apiKey: KEY, team: 'ADW', fetch: listingOf(page) });
  const error = await adapter.listDesignated('sail').then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeDefined();
  expect(error).toMatchObject({ code: 'invalid' });
});

test('listDesignated asks for pages of ten tickets', async () => {
  const world = createLinearWorld({ issues: [issue('ADW-1', 'Todo')] });
  await createLinearTicketSource({ apiKey: KEY, team: 'ADW', fetch: world.transport }).listDesignated('sail');
  expect(world.requests.filter((sent) => sent.operation === 'ListIssues').map((sent) => sent.variables.first)).toEqual([
    10,
  ]);
});

test('listDesignated lists the designated tickets in backlog or unstarted, and no others, each as a parsed Ticket', async () => {
  const world = createLinearWorld({
    issues: [
      issue('ADW-1', 'Todo'),
      issue('ADW-2', 'Backlog'),
      issue('ADW-3', 'In Progress'),
      issue('ADW-4', 'Done'),
      issue('ADW-5', 'Canceled'),
      issue('ADW-6', 'Duplicate'),
      issue('ADW-7', 'Todo', []),
    ],
  });
  const adapter = createLinearTicketSource({ apiKey: KEY, team: 'ADW', fetch: world.transport });
  const listed = await adapter.listDesignated('sail');
  expect(listed.flatMap((ticket) => parseIssues(Ticket, ticket))).toEqual([]);
  expect(keysOf(listed)).toEqual(['ADW-1', 'ADW-2']);
});

test('listDesignated pages through every page, and returns every match', async () => {
  const world = createLinearWorld({
    pageSize: 2,
    issues: ['ADW-1', 'ADW-2', 'ADW-3', 'ADW-4', 'ADW-5'].map((key) => issue(key, 'Todo')),
  });
  const adapter = createLinearTicketSource({ apiKey: KEY, team: 'ADW', fetch: world.transport });
  const listed = await adapter.listDesignated('sail');
  expect(keysOf(listed)).toEqual(['ADW-1', 'ADW-2', 'ADW-3', 'ADW-4', 'ADW-5']);
  expect(world.requests.filter((sent) => sent.operation === 'ListIssues').length).toBeGreaterThan(1);
});

test('listDesignated classifies by state type, so a team with renamed states lists the same tickets', async () => {
  const renamed: WorldState[] = [
    { id: 'state-icebox', name: 'Icebox', type: 'backlog', position: 0 },
    { id: 'state-ready', name: 'Ready', type: 'unstarted', position: 1 },
    { id: 'state-doing', name: 'Doing', type: 'started', position: 2 },
    { id: 'state-shipped', name: 'Shipped', type: 'completed', position: 3 },
    { id: 'state-dropped', name: 'Dropped', type: 'canceled', position: 4 },
    { id: 'state-dupe', name: 'Dupe', type: 'duplicate', position: 5 },
  ];
  const world = createLinearWorld({
    states: renamed,
    issues: [
      issue('ADW-1', 'Ready'),
      issue('ADW-2', 'Icebox'),
      issue('ADW-3', 'Doing'),
      issue('ADW-4', 'Shipped'),
      issue('ADW-5', 'Dropped'),
      issue('ADW-6', 'Dupe'),
      issue('ADW-7', 'Ready', []),
    ],
  });
  const adapter = createLinearTicketSource({ apiKey: KEY, team: 'ADW', fetch: world.transport });
  expect(keysOf(await adapter.listDesignated('sail'))).toEqual(['ADW-1', 'ADW-2']);
  const types = [];
  for (const key of ['ADW-1', 'ADW-2', 'ADW-3', 'ADW-4', 'ADW-5', 'ADW-6']) {
    types.push((await adapter.get(key)).state.type);
  }
  expect(types).toEqual(['unstarted', 'unstarted', 'started', 'completed', 'canceled', 'canceled']);
});

test('capabilities parse, and list in-review only when inReviewState names a state', () => {
  const world = createLinearWorld({ states: ADW_STATES });
  const named = createLinearTicketSource({
    apiKey: KEY,
    team: 'ADW',
    inReviewState: 'In Review',
    fetch: world.transport,
  }).capabilities();
  const unnamed = createLinearTicketSource({ apiKey: KEY, team: 'ADW', fetch: world.transport }).capabilities();
  expect([parseIssues(TicketSourceCapabilities, named), parseIssues(TicketSourceCapabilities, unnamed)]).toEqual([
    [],
    [],
  ]);
  expect(named).toEqual({
    comments: true,
    links: true,
    attachments: true,
    moves: ['unstarted', 'in-progress', 'in-review', 'done'],
  });
  expect(unnamed.moves).toEqual(['unstarted', 'in-progress', 'done']);
});
