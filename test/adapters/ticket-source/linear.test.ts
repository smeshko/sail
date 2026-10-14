// The linear TicketSource: the port suite on a scripted Linear world (test/helpers/linear-world.ts), then what only
// Linear does: keys and URLs of a team, comment pages, the designated list by state type, moves by type and position,
// and the adapter definition read from `project.yaml` and the operator's environment. Every case builds its own world,
// and nothing reaches Linear itself.
//
// Against the sandbox team, the suite runs only when SAIL_LIVE_TICKET_SOURCE=1 (DECISIONS D9). Without it the live suite
// is not registered at all. Its world is named by SAIL_LIVE_LINEAR_TEAM, _LABEL, _DESIGNATED, _STARTED, _UNDESIGNATED and
// _IN_REVIEW, and LINEAR_API_KEY.
import { describe, expect, test } from 'bun:test';
import { createLinearTicketSource, linearTicketSource } from '../../../src/adapters/ticket-source/linear';
import { LINEAR_ENDPOINT } from '../../../src/adapters/ticket-source/linear-client';
import type { ProviderEmit, ProviderEvent } from '../../../src/events/types';
import type { AdapterContext, Env } from '../../../src/ports/adapter';
import type { TicketSource } from '../../../src/ports/ticket-source';
import { Ticket, type TicketMove } from '../../../src/ports/types';
import {
  createLinearWorld,
  type LinearWorld,
  type LinearWorldSeed,
  RENAMED_STATES,
  WORLD_WORKSPACE,
  type WorldState,
} from '../../helpers/linear-world';
import {
  type Captured,
  captureEvents,
  messageOf,
  parseIssues,
  portFailure,
  rejection,
  timed,
} from '../../helpers/ports';
import { type MakeTicketSource, ticketSourceSuite } from '../../ports/ticket-source.suite';

/** A marker key: the world refuses any other. */
const KEY = 'lin_api_MARKER_adapter_5c2e07';
const URL_OF = (key: string) => `https://linear.app/${WORLD_WORKSPACE}/issue/${key}`;
const RATE_LIMITED = {
  status: 400,
  body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
  headers: { 'X-RateLimit-Requests-Reset': '1791972000000' },
};

/**
 * Team ADW, its states renamed from Linear's defaults. ADW-1 is designated and Ready, with a comment, a relation and an
 * attachment. ADW-2 is designated and Building. ADW-3 is Ready without the label. ADW-8 is designated and in Icebox, a
 * backlog-type state, and ADW-9 designated and Shipped.
 */
const SEED: LinearWorldSeed = {
  team: { key: 'ADW', states: RENAMED_STATES },
  apiKey: KEY,
  tickets: [
    {
      number: 1,
      title: 'Add a greeting',
      description: 'Greet the user by name.',
      state: 'Ready',
      labels: ['sail', 'cli'],
      comments: [{ body: 'Keep it short.', createdAt: '2026-10-01T09:00:00.000Z', user: 'Ada' }],
      relations: [{ type: 'blocks', number: 2 }],
      attachments: [{ title: 'Design', url: 'https://example.com/design' }],
    },
    { number: 2, title: 'Say goodbye', state: 'Building', labels: ['sail'] },
    { number: 3, title: 'Wave', state: 'Ready', labels: [] },
    { number: 8, title: 'Bow', state: 'Icebox', labels: ['sail'] },
    { number: 9, title: 'Shake hands', state: 'Shipped', labels: ['sail'] },
  ],
};

interface Made {
  world: LinearWorld;
  adapter: TicketSource;
  capture: Captured<ProviderEvent>;
}

/** A linear adapter for team ADW on a fresh world of `seed`, its `inReview` as given, its events captured. */
function linear(seed: LinearWorldSeed = SEED, options: { inReview?: string; emit?: ProviderEmit } = {}): Made {
  const world = createLinearWorld(seed);
  const capture = captureEvents();
  const adapter = createLinearTicketSource({
    team: 'ADW',
    endpoint: LINEAR_ENDPOINT,
    apiKey: KEY,
    fetch: world.fetch,
    emit: options.emit ?? capture.emit,
    ...(options.inReview === undefined ? {} : { inReview: options.inReview }),
  });
  return { world, adapter, capture };
}

/** A seed of team ADW with `states` and `tickets`. */
const seedOf = (states: readonly WorldState[], tickets: LinearWorldSeed['tickets'], pageSize?: number) => ({
  team: { key: 'ADW', states },
  apiKey: KEY,
  tickets,
  ...(pageSize === undefined ? {} : { pageSize }),
});

/** A PortError's port, op and code, with its message. */
const failure = (error: unknown) => [portFailure(error), messageOf(error)];

const context = (env: Env): AdapterContext => ({
  root: '/nowhere',
  sailDir: '/nowhere/.sail',
  runsDir: '/nowhere/.sail-runs',
  env,
});

// The port suite, offline: a fresh world per case, its review state named Code Review.

describe('the port suite', () => {
  ticketSourceSuite('linear', async (emit) => ({
    adapter: linear(SEED, { inReview: 'Code Review', emit }).adapter,
    world: {
      label: 'sail',
      designated: 'ADW-1',
      started: 'ADW-2',
      undesignated: 'ADW-3',
      missing: 'ADW-999',
      refs: [
        ['ADW-1', 'ADW-1'],
        [`${URL_OF('ADW-12')}/add-a-greeting`, 'ADW-12'],
        [URL_OF('ADW-7'), 'ADW-7'],
      ],
    },
  }));
});

/** The suite against the sandbox team, on its tickets as the environment names them, each case from a reset world. */
const live: MakeTicketSource = async (emit) => {
  const env = process.env;
  const need = (name: string) => {
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`the live suite needs ${name}`);
    return value;
  };
  const options = {
    team: need('SAIL_LIVE_LINEAR_TEAM'),
    inReview: need('SAIL_LIVE_LINEAR_IN_REVIEW'),
    endpoint: LINEAR_ENDPOINT,
    apiKey: need('LINEAR_API_KEY'),
  };
  const world = {
    label: need('SAIL_LIVE_LINEAR_LABEL'),
    designated: need('SAIL_LIVE_LINEAR_DESIGNATED'),
    started: need('SAIL_LIVE_LINEAR_STARTED'),
    undesignated: need('SAIL_LIVE_LINEAR_UNDESIGNATED'),
    missing: `${options.team}-999999`,
    refs: [[need('SAIL_LIVE_LINEAR_DESIGNATED'), need('SAIL_LIVE_LINEAR_DESIGNATED')]] as const,
  };
  const reset = createLinearTicketSource(options);
  await reset.update(world.designated, { state: 'unstarted' });
  await reset.update(world.undesignated, { state: 'unstarted' });
  await reset.update(world.started, { state: 'in-progress' });
  return { adapter: createLinearTicketSource({ ...options, emit }), world };
};
if (process.env.SAIL_LIVE_TICKET_SOURCE === '1') ticketSourceSuite('linear (live)', live);

// Reads.

test('parseKey takes a ticket key or a linear.app ticket URL, with or without its slug, query and fragment, and a key of another team as written', () => {
  const { adapter } = linear();
  const refs = [
    'ADW-23',
    URL_OF('ADW-23'),
    `${URL_OF('ADW-23')}/add-a-greeting`,
    `${URL_OF('ADW-23')}/add-a-greeting?view=all#comment-2`,
    `${URL_OF('ADW-23')}#top`,
    'ZZZ-4',
    'adw-23',
    'ADW-0',
    'ADW-',
    '23',
    'https://github.com/smeshko/sail/issues/23',
  ];
  expect(refs.map((ref) => adapter.parseKey(ref))).toEqual([
    'ADW-23',
    'ADW-23',
    'ADW-23',
    'ADW-23',
    'ADW-23',
    'ZZZ-4',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test('get answers the ticket from one SailTicket request by team and number, and emits one ticket:fetched with its counts', async () => {
  const { world, adapter, capture } = linear();
  const ticket = await adapter.get('ADW-1');
  expect(parseIssues(Ticket, ticket)).toEqual([]);
  expect([ticket.ticketKey, ticket.state, ticket.labels, ticket.comments.map((comment) => comment.body)]).toEqual([
    'ADW-1',
    { type: 'unstarted', name: 'Ready' },
    ['sail', 'cli'],
    ['Keep it short.'],
  ]);
  expect(world.requests.map((request) => [request.operationName, request.variables])).toEqual([
    ['SailTicket', { team: 'ADW', number: 1 }],
  ]);
  expect(timed(capture.events)).toEqual([
    {
      type: 'ticket:fetched',
      ticketKey: 'ADW-1',
      title: 'Add a greeting',
      url: URL_OF('ADW-1'),
      comments: 1,
      links: 2,
      attachments: 1,
      durationMs: 'ms',
    },
  ]);
});

test('get reads a ticket with more comments than a page holds through one SailTicketComments request per extra page, and answers them all in order', async () => {
  const comments = [1, 2, 3, 4, 5].map((n) => ({ body: `Comment ${n}`, createdAt: `2026-10-0${n}T09:00:00.000Z` }));
  const { world, adapter } = linear(
    seedOf(RENAMED_STATES, [{ number: 1, title: 'Talk', state: 'Ready', comments }], 2),
  );
  const ticket = await adapter.get('ADW-1');
  expect(ticket.comments.map((comment) => comment.body)).toEqual([
    'Comment 1',
    'Comment 2',
    'Comment 3',
    'Comment 4',
    'Comment 5',
  ]);
  expect(world.requests.map((request) => [request.operationName, request.variables])).toEqual([
    ['SailTicket', { team: 'ADW', number: 1 }],
    ['SailTicketComments', { id: 'issue-1', after: '1' }],
    ['SailTicketComments', { id: 'issue-1', after: '3' }],
  ]);
});

test('get of an unknown ticket is not_found and emits nothing, and of a key of another team is invalid, naming both teams, without a request', async () => {
  const { world, adapter, capture } = linear();
  const missing = await rejection(adapter.get('ADW-999'));
  const sent = world.requests.length;
  const other = await rejection(adapter.get('ZZZ-1'));
  expect([failure(missing), failure(other), world.requests.length - sent, capture.events]).toEqual([
    [{ port: 'ticketSource', op: 'get', code: 'not_found' }, 'ticketSource.get: no ticket ADW-999 in team ADW'],
    [
      { port: 'ticketSource', op: 'get', code: 'invalid' },
      'ticketSource.get: ZZZ-1 is a ticket of team ZZZ, and this ticket source reads team ADW',
    ],
    0,
    [],
  ]);
});

test('listDesignated answers exactly the designated tickets in triage, backlog and unstarted-type states, by number, across pages, whatever the states are called', async () => {
  const designated = ['sail'];
  const { world, adapter } = linear(
    seedOf(
      RENAMED_STATES,
      [
        { number: 5, title: 'Five', state: 'Inbox', labels: designated },
        { number: 2, title: 'Two', state: 'Icebox', labels: designated },
        { number: 4, title: 'Four', state: 'Ready', labels: designated },
        { number: 1, title: 'One', state: 'Building', labels: designated },
        { number: 6, title: 'Six', state: 'Shipped', labels: designated },
        { number: 7, title: 'Seven', state: 'Dropped', labels: designated },
        { number: 3, title: 'Three', state: 'Ready', labels: ['other'] },
      ],
      2,
    ),
  );
  const listed = await adapter.listDesignated('sail');
  expect(listed.flatMap((ticket) => parseIssues(Ticket, ticket))).toEqual([]);
  expect(listed.map((ticket) => [ticket.ticketKey, ticket.state])).toEqual([
    ['ADW-2', { type: 'unstarted', name: 'Icebox' }],
    ['ADW-4', { type: 'unstarted', name: 'Ready' }],
    ['ADW-5', { type: 'unstarted', name: 'Inbox' }],
  ]);
  expect(world.operations()).toEqual(['SailDesignated', 'SailDesignated']);
});

test('a failure Linear answers to SailDesignated or SailTicket rejects with the client’s PortError and Linear’s message', async () => {
  const { world, adapter } = linear();
  world.failNext('SailDesignated', RATE_LIMITED);
  world.failNext('SailTicket', {
    status: 401,
    body: {
      errors: [{ message: 'Authentication required, not authenticated', extensions: { code: 'AUTHENTICATION_ERROR' } }],
    },
  });
  const errors = [await rejection(adapter.listDesignated('sail')), await rejection(adapter.get('ADW-1'))];
  expect(errors.map(failure)).toEqual([
    [
      { port: 'ticketSource', op: 'listDesignated', code: 'unavailable' },
      'ticketSource.listDesignated: Linear 400: Rate limit exceeded; the rate limit resets at 2026-10-14T10:00:00.000Z',
    ],
    [
      { port: 'ticketSource', op: 'get', code: 'unauthorized' },
      'ticketSource.get: Linear 401: Authentication required, not authenticated',
    ],
  ]);
});

// Writes.

test('a claim takes a designated backlog-type ticket to the first started state by position that is not the review state, and a claim on a completed-type ticket is not taken and moves nothing', async () => {
  const { world, adapter, capture } = linear(SEED, { inReview: 'Code Review' });
  const taken = await adapter.claim('ADW-8');
  const kept = await adapter.claim('ADW-9');
  expect([taken.claimed, taken.state, world.ticket(8).state]).toEqual([
    true,
    { type: 'started', name: 'Building' },
    'Building',
  ]);
  expect([kept.claimed, kept.state, world.ticket(9).state]).toEqual([
    false,
    { type: 'completed', name: 'Shipped' },
    'Shipped',
  ]);
  expect(world.operations().filter((operation) => operation === 'SailMove')).toEqual(['SailMove']);
  expect(capture.events).toEqual([
    { type: 'ticket:claimed', ticketKey: 'ADW-8', state: { type: 'started', name: 'Building' } },
  ]);
});

test('update lands each move by state type: done on the lowest-position completed state of two, and unstarted on the backlog state of a team with no unstarted-type state', async () => {
  const states: WorldState[] = [
    { id: 's-later', name: 'Later', type: 'backlog', position: 0 },
    { id: 's-doing', name: 'Doing', type: 'started', position: 1 },
    { id: 's-shipped', name: 'Shipped', type: 'completed', position: 5 },
    { id: 's-released', name: 'Released', type: 'completed', position: 4 },
  ];
  const { world, adapter } = linear(seedOf(states, [{ number: 1, title: 'One', state: 'Doing', labels: ['sail'] }]));
  const done = await adapter.update('ADW-1', { state: 'done' });
  const doneIn = world.ticket(1).state;
  const back = await adapter.update('ADW-1', { state: 'unstarted' });
  expect([done.state, doneIn, back.state, world.ticket(1).state]).toEqual([
    { type: 'completed', name: 'Released' },
    'Released',
    { type: 'unstarted', name: 'Later' },
    'Later',
  ]);
});

test('without inReview, capabilities leave in-review out and update to it is invalid, naming the option; an inReview that names no started state is invalid too', async () => {
  const plain = linear(SEED);
  const misnamed = linear(SEED, { inReview: 'Shipped' });
  const errors = [
    await rejection(plain.adapter.update('ADW-1', { state: 'in-review' })),
    await rejection(misnamed.adapter.update('ADW-1', { state: 'in-review' })),
  ];
  expect(plain.adapter.capabilities()).toEqual({
    comments: true,
    links: true,
    attachments: true,
    moves: ['unstarted', 'in-progress', 'done'],
  });
  expect(errors.map(failure)).toEqual([
    [
      { port: 'ticketSource', op: 'update', code: 'invalid' },
      'ticketSource.update: in-review is no move without the inReview option',
    ],
    [
      { port: 'ticketSource', op: 'update', code: 'invalid' },
      "ticketSource.update: the inReview option names 'Shipped', which is no started state of team ADW",
    ],
  ]);
  expect([plain.world.ticket(1).state, misnamed.world.ticket(1).state]).toEqual(['Ready', 'Ready']);
});

test('update with something that is no move is invalid, and sends Linear nothing', async () => {
  const { world, adapter } = linear(SEED, { inReview: 'Code Review' });
  const error = await rejection(adapter.update('ADW-1', { state: 'closed' as TicketMove }));
  expect([portFailure(error), world.requests]).toEqual([{ port: 'ticketSource', op: 'update', code: 'invalid' }, []]);
});

test('the team’s states are read once per adapter, across several writes', async () => {
  const { world, adapter } = linear(SEED, { inReview: 'Code Review' });
  await adapter.claim('ADW-1');
  await adapter.update('ADW-1', { state: 'done' });
  await adapter.update('ADW-3', { state: 'in-review' });
  const count = (name: string) => world.operations().filter((operation) => operation === name).length;
  expect([count('SailTeam'), count('SailMove')]).toEqual([1, 3]);
});

test('a rate limit on the move rejects the claim as unavailable with Linear’s message, leaves the ticket where it was, and emits nothing', async () => {
  const { world, adapter, capture } = linear(SEED, { inReview: 'Code Review' });
  world.failNext('SailMove', RATE_LIMITED);
  const error = await rejection(adapter.claim('ADW-1'));
  expect([failure(error), world.ticket(1).state, capture.events]).toEqual([
    [
      { port: 'ticketSource', op: 'claim', code: 'unavailable' },
      'ticketSource.claim: Linear 400: Rate limit exceeded; the rate limit resets at 2026-10-14T10:00:00.000Z',
    ],
    'Ready',
    [],
  ]);
});

test('Linear answering success: false to the move or the comment is a conflict, and emits nothing', async () => {
  const { world, adapter, capture } = linear(SEED, { inReview: 'Code Review' });
  const ready = { id: 'state-ready', name: 'Ready', type: 'unstarted' };
  const comment = { id: 'comment-9', url: `${URL_OF('ADW-1')}#comment-9` };
  world.failNext('SailMove', {
    status: 200,
    body: { data: { issueUpdate: { success: false, issue: { id: 'issue-1', state: ready } } } },
  });
  world.failNext('SailComment', { status: 200, body: { data: { commentCreate: { success: false, comment } } } });
  const errors = [
    await rejection(adapter.update('ADW-1', { state: 'done' })),
    await rejection(adapter.comment('ADW-1', 'Pull request opened.')),
  ];
  expect([errors.map(portFailure), capture.events]).toEqual([
    [
      { port: 'ticketSource', op: 'update', code: 'conflict' },
      { port: 'ticketSource', op: 'comment', code: 'conflict' },
    ],
    [],
  ]);
});

// The definition: `ticketSource: { use: linear, team, inReview }`, its key and endpoint from the environment.

test('the definition requires LINEAR_API_KEY, whatever its options', () => {
  expect([
    linearTicketSource.requires?.({ team: 'ADW' }, {}),
    linearTicketSource.requires?.({ team: 'ADW', inReview: 'In Review' }, { LINEAR_API_KEY: KEY }),
  ]).toEqual([['LINEAR_API_KEY'], ['LINEAR_API_KEY']]);
});

test('the definition creates the adapter from team and inReview without a request, and it reads through SAIL_LINEAR_API_URL with LINEAR_API_KEY as the bare Authorization header', async () => {
  const world = createLinearWorld(SEED);
  const served = world.serve();
  try {
    const env = { LINEAR_API_KEY: KEY, SAIL_LINEAR_API_URL: served.url };
    const adapter = await linearTicketSource.create({ team: 'ADW', inReview: 'Code Review' }, context(env));
    expect([adapter.name, adapter.capabilities().moves, world.requests.length]).toEqual([
      'linear',
      ['unstarted', 'in-progress', 'in-review', 'done'],
      0,
    ]);
    const ticket = await adapter.get('ADW-1');
    expect([ticket.title, world.requests.map((request) => request.headers.authorization)]).toEqual([
      'Add a greeting',
      [KEY],
    ]);
  } finally {
    served.stop();
  }
});

test('without SAIL_LINEAR_API_URL, the definition sends to Linear’s own endpoint', async () => {
  const world = createLinearWorld(SEED);
  const sentTo: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      sentTo.push(String(input));
      return world.fetch(String(input), init ?? {});
    },
    { preconnect: original.preconnect },
  );
  try {
    const adapter = await linearTicketSource.create({ team: 'ADW' }, context({ LINEAR_API_KEY: KEY }));
    await rejection(adapter.get('ADW-1'));
  } finally {
    globalThis.fetch = original;
  }
  expect(sentTo).toEqual(['https://api.linear.app/graphql']);
});

test('the definition refuses options it cannot read, naming the option: no team, a team key in lower case, an option it does not take', async () => {
  const refused = async (options: Record<string, unknown>) =>
    messageOf(await rejection(Promise.resolve().then(() => linearTicketSource.create(options, context({})))));
  expect([
    await refused({}),
    await refused({ team: 'adw' }),
    await refused({ team: 'ADW', apiUrl: 'https://example.com/graphql' }),
  ]).toEqual([
    'linear ticketSource: option team: Invalid input: expected string, received undefined',
    'linear ticketSource: option team: must be a Linear team key, such as ADW',
    'linear ticketSource: option apiUrl: Unrecognized key: "apiUrl"',
  ]);
});
