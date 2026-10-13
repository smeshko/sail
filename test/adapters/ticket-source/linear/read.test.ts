// Reading one Linear ticket (TASK-003): parseKey, get and isDesignated, with the state mapping and the team check.
import { expect, test } from 'bun:test';
import { createLinearTicketSource } from '../../../../src/adapters/ticket-source/linear/index';
import { FETCH_ISSUE, FETCH_MORE_COMMENTS } from '../../../../src/adapters/ticket-source/linear/queries';
import { Ticket } from '../../../../src/ports/types';
import { ADW_STATES, createLinearWorld, type WorldIssue, type WorldState } from '../../../helpers/linear-world';
import { captureEvents, messageOf, parseIssues, portFailure, rejection, timed } from '../../../helpers/ports';

const KEY = 'lin_api_SENTINEL-read-key';
const URL_BASE = 'https://linear.app/sail-fixture/issue';

/** The adapter for the ADW team over `world`, and what it emits. */
function adapterOver(world: ReturnType<typeof createLinearWorld>) {
  const capture = captureEvents();
  const adapter = createLinearTicketSource({
    apiKey: KEY,
    team: 'ADW',
    fetch: world.transport,
    emit: capture.emit,
  });
  return { adapter, capture };
}

const issue = (identifier: string, state: string, extra: Partial<WorldIssue> = {}): WorldIssue => ({
  identifier,
  title: `Ticket ${identifier}`,
  state,
  labels: ['sail'],
  ...extra,
});

test('parseKey gives the key of this team, from a bare key or its issue URL, and nothing for another team or a bad key', () => {
  const { adapter } = adapterOver(createLinearWorld());
  const refs = ['ADW-95', `${URL_BASE}/ADW-95/add-a-shout-flag`, 'OPS-1', 'not a key', 'adw-95', 'ADW-007', 'ADW-0'];
  expect(refs.map((ref) => adapter.parseKey(ref))).toEqual([
    'ADW-95',
    'ADW-95',
    undefined,
    undefined,
    undefined,
    // Review fix (review #1.11): a key is spelt as Linear numbers it, so ADW-007 is not this team's key.
    undefined,
    undefined,
  ]);
});

test('get gives the ticket with the GraphQL node as raw, and emits one ticket:fetched that names it', async () => {
  const world = createLinearWorld({
    issues: [
      issue('ADW-1', 'Todo', {
        title: 'Add a --shout flag',
        description: 'Add it.',
        comments: [{ body: 'Upper-case it.' }],
      }),
    ],
  });
  const { adapter, capture } = adapterOver(world);
  const ticket = await adapter.get('ADW-1');
  expect(parseIssues(Ticket, ticket)).toEqual([]);
  expect({
    ticketKey: ticket.ticketKey,
    title: ticket.title,
    url: ticket.url,
    description: ticket.description,
    state: ticket.state,
    labels: ticket.labels,
    comments: ticket.comments,
  }).toEqual({
    ticketKey: 'ADW-1',
    title: 'Add a --shout flag',
    url: `${URL_BASE}/ADW-1`,
    description: 'Add it.',
    state: { type: 'unstarted', name: 'Todo' },
    labels: ['sail'],
    comments: [{ author: 'fixture-user', body: 'Upper-case it.', createdAt: '2026-10-02T09:00:00.000Z' }],
  });
  expect(ticket.raw).toMatchObject({ identifier: 'ADW-1', title: 'Add a --shout flag', state: { name: 'Todo' } });
  expect(timed(capture.events)).toEqual([
    {
      type: 'ticket:fetched',
      ticketKey: 'ADW-1',
      title: 'Add a --shout flag',
      url: `${URL_BASE}/ADW-1`,
      comments: 1,
      links: 0,
      attachments: 0,
      durationMs: 'ms',
    },
  ]);
});

test('a null description reads as empty, and a comment with no user reads as by unknown', async () => {
  const world = createLinearWorld({
    issues: [issue('ADW-2', 'Todo', { description: null, comments: [{ body: 'Anonymous.', author: null }] })],
  });
  const { adapter } = adapterOver(world);
  const ticket = await adapter.get('ADW-2');
  expect({ description: ticket.description, comments: ticket.comments.map((c) => [c.author, c.body]) }).toEqual({
    description: '',
    comments: [['unknown', 'Anonymous.']],
  });
});

test('relations read as links titled by identifier and title, and attachments as their name and URL', async () => {
  const world = createLinearWorld({
    issues: [
      issue('ADW-3', 'Todo', {
        relations: [{ type: 'related', identifier: 'ADW-7', title: 'Shout the output' }],
        attachments: [{ title: 'spec.pdf', url: 'https://files.example/spec.pdf' }],
      }),
    ],
  });
  const { adapter } = adapterOver(world);
  const ticket = await adapter.get('ADW-3');
  expect({ links: ticket.links, attachments: ticket.attachments }).toEqual({
    links: [{ url: `${URL_BASE}/ADW-7`, title: 'ADW-7 Shout the output' }],
    attachments: [{ name: 'spec.pdf', url: 'https://files.example/spec.pdf' }],
  });
});

test('a ticket with more comments than one page is read in full, through FetchMoreComments', async () => {
  const bodies = ['one', 'two', 'three', 'four', 'five'];
  const world = createLinearWorld({
    pageSize: 2,
    issues: [issue('ADW-4', 'Todo', { comments: bodies.map((body) => ({ body })) })],
  });
  const { adapter } = adapterOver(world);
  const ticket = await adapter.get('ADW-4');
  expect(ticket.comments.map((comment) => comment.body)).toEqual(bodies);
  expect(world.requests.map((sent) => sent.operation)).toContain('FetchMoreComments');
});

test('an unknown key is not_found, naming the key, and emits nothing', async () => {
  const { adapter, capture } = adapterOver(createLinearWorld());
  const error = await rejection(adapter.get('ADW-99'));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'get', code: 'not_found' });
  expect(messageOf(error)).toContain('no ticket ADW-99');
  expect(capture.events).toEqual([]);
});

test('a ticket in triage is refused by get as invalid, naming the triage type, and emits nothing', async () => {
  const states: WorldState[] = [...ADW_STATES, { id: 'state-triage', name: 'Triage', type: 'triage', position: 7 }];
  const world = createLinearWorld({ states, issues: [issue('ADW-5', 'Triage')] });
  const { adapter, capture } = adapterOver(world);
  const error = await rejection(adapter.get('ADW-5'));
  expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'get', code: 'invalid' });
  expect(messageOf(error)).toContain('triage');
  expect(capture.events).toEqual([]);
});

test('Linear state types fold onto sail states: backlog and unstarted are unstarted, duplicate is canceled, and the name stays', async () => {
  const world = createLinearWorld({
    issues: [
      issue('ADW-1', 'Backlog'),
      issue('ADW-2', 'Todo'),
      issue('ADW-3', 'In Progress'),
      issue('ADW-4', 'Done'),
      issue('ADW-5', 'Canceled'),
      issue('ADW-6', 'Duplicate'),
    ],
  });
  const { adapter } = adapterOver(world);
  const states = [];
  for (const key of ['ADW-1', 'ADW-2', 'ADW-3', 'ADW-4', 'ADW-5', 'ADW-6']) {
    states.push((await adapter.get(key)).state);
  }
  expect(states).toEqual([
    { type: 'unstarted', name: 'Backlog' },
    { type: 'unstarted', name: 'Todo' },
    { type: 'started', name: 'In Progress' },
    { type: 'completed', name: 'Done' },
    { type: 'canceled', name: 'Canceled' },
    { type: 'canceled', name: 'Duplicate' },
  ]);
});

test('isDesignated holds for the label it is given, and only for it', async () => {
  const world = createLinearWorld({
    issues: [issue('ADW-1', 'Todo', { labels: ['sail'] }), issue('ADW-3', 'Todo', { labels: [] })],
  });
  const { adapter } = adapterOver(world);
  const designated = await adapter.get('ADW-1');
  const undesignated = await adapter.get('ADW-3');
  expect([
    adapter.isDesignated(designated, 'sail'),
    adapter.isDesignated(undesignated, 'sail'),
    adapter.isDesignated(designated, 'other'),
  ]).toEqual([true, false, false]);
});

test('the read documents are named for their operations, and neither asks for an e-mail address', () => {
  expect(FETCH_ISSUE).toContain('query FetchIssue');
  expect(FETCH_MORE_COMMENTS).toContain('query FetchMoreComments');
  expect(/email/i.test(`${FETCH_ISSUE}\n${FETCH_MORE_COMMENTS}`)).toBe(false);
});

// Review fix (review #1.1): the ticket read asks for one issue, not the default page of fifty, so its comment requests
// stay under Linear's complexity cap.
test('the ticket read asks for one issue', () => {
  expect(/\bfirst: 1\b/.test(FETCH_ISSUE)).toBe(true);
});

// Review fixes (review #2.2 and #2.7): a state type that carries terminal control characters is refused without them,
// and a comment cursor that brings no new comments is refused as invalid.
test('a state type with terminal control characters is refused without them', async () => {
  const world = createLinearWorld({
    issues: [issue('ADW-1', 'Todo')],
    states: [{ id: 'state-todo', name: 'Todo', type: 'tri\x1b[2J\x1b[Hage\r', position: 1 }],
  });
  const message = messageOf(await rejection(adapterOver(world).adapter.get('ADW-1')));
  expect([message.includes('\x1b'), message.includes('\r')]).toEqual([false, false]);
});

test('a comment cursor that repeats, or brings no comments, is refused as invalid', async () => {
  const comment = { id: 'c0', body: 'first', createdAt: '2026-10-02T09:00:00.000Z', user: { name: 'a' } };
  const node = {
    id: 'issue-1',
    identifier: 'ADW-1',
    title: 'Ticket ADW-1',
    description: null,
    url: 'https://linear.app/sail-fixture/issue/ADW-1',
    priority: 0,
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', position: 1 },
    labels: { nodes: [{ name: 'sail' }] },
    assignee: null,
    comments: { nodes: [comment], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    relations: { nodes: [] },
    attachments: { nodes: [] },
  };
  const answers = [
    { nodes: [comment], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'c2' } },
  ];
  for (const page of answers) {
    const transport = (async (_input: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as { operationName?: string };
      const data = sent.operationName === 'FetchIssue' ? { issues: { nodes: [node] } } : { issue: { comments: page } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createLinearTicketSource({ apiKey: KEY, team: 'ADW', fetch: transport });
    expect(portFailure(await rejection(adapter.get('ADW-1')))).toMatchObject({ code: 'invalid' });
  }
});
