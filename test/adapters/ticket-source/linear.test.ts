// The linear TicketSource: the port suite on a scripted Linear world (test/helpers/linear-world.ts), then what only
// Linear does: keys and URLs of a team, comment pages, the designated list by state type, moves by type and position,
// and the adapter definition read from `project.yaml` and the operator's environment. Every case builds its own world,
// and nothing reaches Linear itself.
//
// Against the sandbox team, the suite runs only when SAIL_LIVE_TICKET_SOURCE=1 (DECISIONS D9). Without it the live suite
// is not registered at all. Its world is named by SAIL_LIVE_LINEAR_TEAM, _LABEL, _DESIGNATED, _STARTED, _UNDESIGNATED and
// _IN_REVIEW, _SPARE_LABEL (a label of the team that _DESIGNATED and _UNDESIGNATED don't carry), and LINEAR_API_KEY.
import { describe, expect, test } from 'bun:test';
import { createLinearTicketSource, linearTicketSource } from '../../../src/adapters/ticket-source/linear';
import { type Fetch, LINEAR_ENDPOINT } from '../../../src/adapters/ticket-source/linear-client';
import type { ProviderEmit, ProviderEvent } from '../../../src/events/types';
import type { AdapterContext, Env } from '../../../src/ports/adapter';
import type { TicketSource } from '../../../src/ports/ticket-source';
import { Created, ListedTicket, Relabelled, Related, Ticket, type TicketMove } from '../../../src/ports/types';
import {
  createLinearWorld,
  DEFAULT_STATES,
  type LinearWorld,
  type LinearWorldSeed,
  RENAMED_STATES,
  WORLD_WORKSPACE,
  type WorldState,
} from '../../helpers/linear-world';
import {
  type Captured,
  captureEvents,
  eventIssues,
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
 * backlog-type state, and ADW-9 designated and Shipped. The team has the labels sail, cli and Bug.
 */
const SEED: LinearWorldSeed = {
  team: {
    key: 'ADW',
    states: RENAMED_STATES,
    labels: [
      { id: 'label-sail', name: 'sail' },
      { id: 'label-cli', name: 'cli' },
      { id: 'label-bug', name: 'Bug' },
    ],
  },
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

/** A screenshot, as the demonstrate stage leaves one. */
const FILE = {
  name: 'run view.png',
  contentType: 'image/png',
  bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
};

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
      spareLabel: 'Bug',
      unknownLabel: 'no-such-label',
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
    spareLabel: need('SAIL_LIVE_LINEAR_SPARE_LABEL'),
    unknownLabel: `sail-no-such-label-${Math.random().toString(36).slice(2, 10)}`,
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
  expect(world.operations()).toEqual(['SailDesignated', 'SailDesignated', 'SailTicket', 'SailTicket', 'SailTicket']);
});

test('list pages through the team, filters by state type and label, and answers each ticket by number from its list alone, whatever its state is called', async () => {
  const { world, adapter } = linear(
    seedOf(
      RENAMED_STATES,
      [
        { number: 5, title: 'Five', description: 'Fifth.', state: 'Inbox', labels: ['sail', 'cli'] },
        { number: 2, title: 'Two', description: null, state: 'Icebox', labels: ['sail'] },
        { number: 4, title: 'Four', state: 'Ready', labels: ['cli'] },
        { number: 1, title: 'One', state: 'Building', labels: ['sail'] },
        { number: 6, title: 'Six', state: 'Shipped', labels: ['sail'] },
        { number: 7, title: 'Seven', state: 'Dropped', labels: ['sail'] },
      ],
      1,
    ),
  );
  const unstarted = await adapter.list({ state: 'unstarted' });
  expect(unstarted.flatMap((ticket) => parseIssues(ListedTicket, ticket))).toEqual([]);
  expect(unstarted.map((ticket) => [ticket.ticketKey, ticket.state, ticket.labels, ticket.description])).toEqual([
    ['ADW-2', { type: 'unstarted', name: 'Icebox' }, ['sail'], ''],
    ['ADW-4', { type: 'unstarted', name: 'Ready' }, ['cli'], ''],
    ['ADW-5', { type: 'unstarted', name: 'Inbox' }, ['sail', 'cli'], 'Fifth.'],
  ]);
  expect(unstarted[0]?.url).toBe(URL_OF('ADW-2'));
  expect(world.operations()).toEqual(['SailList', 'SailList', 'SailList']);

  const sail = await adapter.list({ label: 'sail' });
  expect(sail.map((ticket) => ticket.ticketKey)).toEqual(['ADW-1', 'ADW-2', 'ADW-5', 'ADW-6', 'ADW-7']);
  const canceled = await adapter.list({ state: 'canceled' });
  expect(canceled.map((ticket) => [ticket.ticketKey, ticket.state.type])).toEqual([['ADW-7', 'canceled']]);
  const all = await adapter.list({});
  expect(all.map((ticket) => ticket.ticketKey)).toEqual(['ADW-1', 'ADW-2', 'ADW-4', 'ADW-5', 'ADW-6', 'ADW-7']);
});

test('list for a team Linear does not have rejects not_found, naming it', async () => {
  const world = createLinearWorld(SEED);
  const typo = createLinearTicketSource({ team: 'ADX', endpoint: LINEAR_ENDPOINT, apiKey: KEY, fetch: world.fetch });
  expect(failure(await rejection(typo.list({ state: 'unstarted' })))).toEqual([
    { port: 'ticketSource', op: 'list', code: 'not_found' },
    'ticketSource.list: Linear has no team ADX',
  ]);
});

test('listDesignated reads each listed ticket whole, every comment page included, and leaves out one claimed between the list and its read (review R1-1, R1-8)', async () => {
  const comments = [1, 2, 3].map((n) => ({ body: `Comment ${n}`, createdAt: `2026-10-0${n}T09:00:00.000Z` }));
  const world = createLinearWorld(
    seedOf(
      RENAMED_STATES,
      [
        { number: 1, title: 'Talk', state: 'Ready', labels: ['sail'], comments },
        { number: 2, title: 'Race', state: 'Ready', labels: ['sail'] },
      ],
      2,
    ),
  );
  const fetch: Fetch = async (input, init) => {
    const answer = await world.fetch(input, init);
    // Another claimer takes ADW-2 as soon as the list is answered.
    if (world.operations().at(-1) === 'SailDesignated') world.ticket(2).state = 'Building';
    return answer;
  };
  const adapter = createLinearTicketSource({ team: 'ADW', endpoint: LINEAR_ENDPOINT, apiKey: KEY, fetch });
  const listed = await adapter.listDesignated('sail');
  expect(listed.map((ticket) => [ticket.ticketKey, ticket.comments.map((comment) => comment.body)])).toEqual([
    ['ADW-1', ['Comment 1', 'Comment 2', 'Comment 3']],
  ]);
});

test('listDesignated skips a listed ticket gone from the team by its read, and keeps the rest, but a failed read still rejects (review R2-1)', async () => {
  const designated = [
    { number: 1, title: 'Gone', state: 'Ready', labels: ['sail'] },
    { number: 2, title: 'Kept', state: 'Ready', labels: ['sail'] },
  ];
  const gone = linear(seedOf(RENAMED_STATES, designated));
  // ADW-1 is deleted, or moved to another team, after the list: its read by team and number finds nothing.
  gone.world.failNext(
    'SailTicket',
    { status: 200, body: { data: { issues: { nodes: [] } } } },
    { after: 'SailDesignated' },
  );
  const listed = await gone.adapter.listDesignated('sail');
  expect([listed.map((ticket) => ticket.ticketKey), gone.world.operations()]).toEqual([
    ['ADW-2'],
    ['SailDesignated', 'SailTicket', 'SailTeam', 'SailTicket'],
  ]);
  const failed = linear(seedOf(RENAMED_STATES, designated));
  failed.world.failNext(
    'SailTicket',
    { status: 401, body: { errors: [{ message: 'Authentication required, not authenticated' }] } },
    { after: 'SailDesignated' },
  );
  expect(failure(await rejection(failed.adapter.listDesignated('sail')))).toEqual([
    { port: 'ticketSource', op: 'listDesignated', code: 'unauthorized' },
    'ticketSource.listDesignated: Linear 401: Authentication required, not authenticated',
  ]);
});

test('listDesignated skips a listed ticket deleted while its comment pages are read, and keeps the rest (review R3-1)', async () => {
  const comments = [1, 2, 3].map((n) => ({ body: `Comment ${n}`, createdAt: `2026-10-0${n}T09:00:00.000Z` }));
  const world = createLinearWorld(
    seedOf(
      RENAMED_STATES,
      [
        { number: 1, title: 'Gone', state: 'Ready', labels: ['sail'], comments },
        { number: 2, title: 'Kept', state: 'Ready', labels: ['sail'] },
      ],
      2,
    ),
  );
  let deleted = false;
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  // ADW-1 is deleted after its first read: its next comment page, and any later read of it, find nothing.
  const fetch: Fetch = async (input, init) => {
    const { operationName, variables } = JSON.parse(String(init.body));
    if (operationName === 'SailTicketComments' && variables.id === 'issue-1') {
      deleted = true;
      return answer({ errors: [{ message: 'Entity not found: Issue', extensions: { code: 'INPUT_ERROR' } }] }, 400);
    }
    if (deleted && operationName === 'SailTicket' && variables.number === 1)
      return answer({ data: { issues: { nodes: [] } } });
    return world.fetch(input, init);
  };
  const adapter = createLinearTicketSource({ team: 'ADW', endpoint: LINEAR_ENDPOINT, apiKey: KEY, fetch });
  expect((await adapter.listDesignated('sail')).map((ticket) => ticket.ticketKey)).toEqual(['ADW-2']);
});

test('a team Linear doesn’t have is not_found, naming it, where an empty list or no ticket would hide it, and an empty list of a real team is empty (review R1-3)', async () => {
  const world = createLinearWorld(SEED);
  const typo = createLinearTicketSource({ team: 'ADX', endpoint: LINEAR_ENDPOINT, apiKey: KEY, fetch: world.fetch });
  const errors = [await rejection(typo.listDesignated('sail')), await rejection(typo.get('ADX-5'))];
  expect(errors.map(failure)).toEqual([
    [
      { port: 'ticketSource', op: 'listDesignated', code: 'not_found' },
      'ticketSource.listDesignated: Linear has no team ADX',
    ],
    [{ port: 'ticketSource', op: 'get', code: 'not_found' }, 'ticketSource.get: Linear has no team ADX'],
  ]);
  const { world: real, adapter } = linear();
  expect([await adapter.listDesignated('nobody'), real.operations()]).toEqual([[], ['SailDesignated', 'SailTeam']]);
});

test('a page that says another follows but gives no cursor, or one it gave before, is unavailable, not a loop or a short answer (review R1-7)', async () => {
  const comments = [1, 2, 3, 4, 5].map((n) => ({ body: `Comment ${n}`, createdAt: `2026-10-0${n}T09:00:00.000Z` }));
  const seed = seedOf(RENAMED_STATES, [{ number: 1, title: 'Talk', state: 'Ready', labels: ['sail'], comments }], 2);
  const commentsPage = (endCursor: string | null) => ({
    status: 200,
    body: { data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor } } } } },
  });
  const noCursor = linear(seed);
  noCursor.world.failNext('SailTicketComments', commentsPage(null));
  const again = linear(seed);
  again.world.failNext('SailTicketComments', commentsPage('1'));
  const list = linear(seed);
  list.world.failNext('SailDesignated', {
    status: 200,
    body: { data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } },
  });
  const errors = [
    await rejection(noCursor.adapter.get('ADW-1')),
    await rejection(again.adapter.get('ADW-1')),
    await rejection(list.adapter.listDesignated('sail')),
  ];
  expect(errors.map(failure)).toEqual([
    [
      { port: 'ticketSource', op: 'get', code: 'unavailable' },
      'ticketSource.get: Linear said another page of the comments of ADW-1 follows, but gave no cursor',
    ],
    [
      { port: 'ticketSource', op: 'get', code: 'unavailable' },
      'ticketSource.get: Linear said another page of the comments of ADW-1 follows, but gave cursor 1 again',
    ],
    [
      { port: 'ticketSource', op: 'listDesignated', code: 'unavailable' },
      'ticketSource.listDesignated: Linear said another page of the designated tickets follows, but gave no cursor',
    ],
  ]);
});

/**
 * A document's complexity as Linear scores it (https://linear.app/developers/rate-limiting), from above: a field with a
 * selection is an object of 1 point, a leaf 0.1, and a field's children count `first` times, 50 times for a connection
 * that gives no `first`. Linear refuses a document over 10,000 points.
 */
function complexity(document: string): number {
  const tokens: string[] = document.replace(/"[^"]*"/g, '""').match(/[A-Za-z_]\w*|\d+|[{}()]/g) ?? [];
  let at = tokens.indexOf('{') + 1;
  const selection = (): { points: number; connection: boolean } => {
    let points = 0;
    let connection = false;
    while (at < tokens.length && tokens[at] !== '}') {
      connection ||= tokens[at] === 'nodes';
      at++;
      let first: number | undefined;
      if (tokens[at] === '(') {
        let depth = 0;
        do {
          if (tokens[at] === '(') depth++;
          if (tokens[at] === ')') depth--;
          if (depth === 1 && tokens[at] === 'first') first = Number(tokens[at + 1]);
          at++;
        } while (depth > 0);
      }
      if (tokens[at] === '{') {
        at++;
        const children = selection();
        at++;
        points += 1 + (first ?? (children.connection ? 50 : 1)) * children.points;
      } else points += 0.1;
    }
    return { points, connection };
  };
  return selection().points;
}

test('every document the adapter sends stays under Linear’s complexity limit of 10,000 points (review R1-1)', async () => {
  const comments = [1, 2, 3].map((n) => ({ body: `Comment ${n}`, createdAt: `2026-10-0${n}T09:00:00.000Z` }));
  const { world, adapter } = linear(
    seedOf(RENAMED_STATES, [{ number: 1, title: 'Talk', state: 'Ready', labels: ['sail'], comments }], 2),
    { inReview: 'Code Review' },
  );
  await adapter.listDesignated('sail');
  await adapter.claim('ADW-1');
  await adapter.update('ADW-1', { state: 'in-review' });
  await adapter.comment('ADW-1', 'Done.');
  await adapter.create({ title: 'Follow up', description: 'More.', labels: [] });
  await adapter.attach('ADW-1', FILE);
  const sent = world.requests
    .filter((request) => request.operationName !== 'upload')
    .map((request) => [request.operationName, complexity(request.query)] as const);
  expect([...new Set(sent.map(([name]) => name))].sort()).toEqual([
    'SailAttach',
    'SailComment',
    'SailCreate',
    'SailDesignated',
    'SailMove',
    'SailTeam',
    'SailTeamLabels',
    'SailTicket',
    'SailTicketComments',
    'SailUpload',
  ]);
  expect(sent.filter(([, points]) => points > 10_000)).toEqual([]);
  // The estimate is no zero: a ticket and its five connections are worth thousands.
  expect(sent.find(([name]) => name === 'SailTicket')?.[1]).toBeGreaterThan(1_000);
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

test('create sends one SailCreate in the team’s id with the ids of its labels, matched by name whatever their case, answers the new ticket’s key and URL, and emits ticket:created', async () => {
  const { world, adapter, capture } = linear();
  const created = await adapter.create({ title: 'Follow up', description: 'Do the rest.', labels: ['SAIL', 'bug'] });
  expect(parseIssues(Created, created)).toEqual([]);
  expect({ ticketKey: created.ticketKey, url: created.url }).toEqual({ ticketKey: 'ADW-10', url: URL_OF('ADW-10') });
  expect(world.operations()).toEqual(['SailTeamLabels', 'SailCreate']);
  expect(world.requests[1]?.variables).toEqual({
    teamId: 'team-ADW',
    title: 'Follow up',
    description: 'Do the rest.',
    labelIds: ['label-sail', 'label-bug'],
  });
  expect(capture.events).toEqual([
    { type: 'ticket:created', ticketKey: 'ADW-10', title: 'Follow up', url: URL_OF('ADW-10') },
  ]);
  expect(eventIssues(capture.stamped('publish#1/open'))).toEqual([]);
  // The ticket is the team's now: get reads it back, unstarted, with its labels under the team's names.
  const read = await adapter.get('ADW-10');
  expect([read.title, read.description, read.state.type, read.labels]).toEqual([
    'Follow up',
    'Do the rest.',
    'unstarted',
    ['sail', 'Bug'],
  ]);
});

test('create reads the labels across pages, one SailTeamLabels request per page, and finds a label on the last', async () => {
  const labels = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ id: `label-${name}`, name }));
  const { world, adapter } = linear({
    ...seedOf(RENAMED_STATES, [], 2),
    team: { key: 'ADW', states: RENAMED_STATES, labels },
  });
  await adapter.create({ title: 'Last', description: 'x', labels: ['e'] });
  expect(world.operations()).toEqual(['SailTeamLabels', 'SailTeamLabels', 'SailTeamLabels', 'SailCreate']);
  expect(world.requests.at(-1)?.variables.labelIds).toEqual(['label-e']);
});

test('create with a label the team lacks is invalid, naming it and the team, and files nothing: no SailCreate is sent and nothing is emitted', async () => {
  const { world, adapter, capture } = linear();
  const error = await rejection(adapter.create({ title: 'Follow up', description: 'x', labels: ['sail', 'urgent'] }));
  expect(failure(error)).toEqual([
    { port: 'ticketSource', op: 'create', code: 'invalid' },
    'ticketSource.create: team ADW has no label urgent',
  ]);
  expect([world.operations(), capture.events]).toEqual([['SailTeamLabels'], []]);
});

test('addLabel resolves the label by name whatever its case, sends one SailAddLabel with the ticket and label ids, and answers the labels the ticket carries then', async () => {
  const { world, adapter, capture } = linear();
  const added = await adapter.addLabel('ADW-1', 'bug');
  expect(parseIssues(Relabelled, added)).toEqual([]);
  expect([added.ticketKey, added.labels]).toEqual(['ADW-1', ['sail', 'cli', 'Bug']]);
  expect(world.operations()).toEqual(['SailTicket', 'SailTeamLabels', 'SailAddLabel']);
  expect(world.requests[2]?.variables).toEqual({ id: 'issue-1', labelId: 'label-bug' });
  expect(capture.events).toEqual([
    { type: 'ticket:labelled', ticketKey: 'ADW-1', label: 'Bug', labels: ['sail', 'cli', 'Bug'] },
  ]);
  const removed = await adapter.removeLabel('ADW-1', 'BUG');
  expect(removed.labels).toEqual(['sail', 'cli']);
  expect(world.operations().slice(3)).toEqual(['SailTicket', 'SailTeamLabels', 'SailRemoveLabel']);
  expect(world.requests.at(-1)?.variables).toEqual({ id: 'issue-1', labelId: 'label-bug' });
  expect(capture.events.at(-1)).toEqual({
    type: 'ticket:unlabelled',
    ticketKey: 'ADW-1',
    label: 'Bug',
    labels: ['sail', 'cli'],
  });
});

test('addLabel and removeLabel of a label the team lacks are invalid, naming it and the team, after the ticket is found and before any mutation; of a missing ticket, not_found before any label is read', async () => {
  const { world, adapter, capture } = linear();
  const errors = [
    await rejection(adapter.addLabel('ADW-1', 'urgent')),
    await rejection(adapter.removeLabel('ADW-1', 'urgent')),
    await rejection(adapter.addLabel('ADW-999', 'urgent')),
  ];
  expect(errors.map(failure)).toEqual([
    [{ port: 'ticketSource', op: 'addLabel', code: 'invalid' }, 'ticketSource.addLabel: team ADW has no label urgent'],
    [
      { port: 'ticketSource', op: 'removeLabel', code: 'invalid' },
      'ticketSource.removeLabel: team ADW has no label urgent',
    ],
    [
      { port: 'ticketSource', op: 'addLabel', code: 'not_found' },
      'ticketSource.addLabel: no ticket ADW-999 in team ADW',
    ],
  ]);
  expect(world.operations()).toEqual([
    'SailTicket',
    'SailTeamLabels',
    'SailTicket',
    'SailTeamLabels',
    'SailTicket',
    'SailTeam',
  ]);
  expect(capture.events).toEqual([]);
});

test('addLabel of a label the ticket carries and removeLabel of one it lacks send no mutation and emit nothing', async () => {
  const { world, adapter, capture } = linear();
  const same = await adapter.addLabel('ADW-1', 'SAIL');
  const none = await adapter.removeLabel('ADW-1', 'bug');
  expect([same.labels, none.labels]).toEqual([
    ['sail', 'cli'],
    ['sail', 'cli'],
  ]);
  expect(world.operations().filter((name) => name === 'SailAddLabel' || name === 'SailRemoveLabel')).toEqual([]);
  expect(capture.events).toEqual([]);
});

test('addLabel answering success: false is a conflict, and emits nothing', async () => {
  const { world, adapter, capture } = linear();
  world.failNext('SailAddLabel', {
    status: 200,
    body: { data: { issueAddLabel: { success: false, issue: null } } },
  });
  const error = await rejection(adapter.addLabel('ADW-1', 'Bug'));
  expect([portFailure(error), capture.events]).toEqual([
    { port: 'ticketSource', op: 'addLabel', code: 'conflict' },
    [],
  ]);
});

const TWO_TICKETS = [
  { number: 1, title: 'One', state: 'Todo', labels: [] },
  { number: 2, title: 'Two', state: 'Todo', labels: [] },
];

test('relate sends both lookups, then one SailRelate of the ticket to the other by id and kind, and a related or blocks relation moves nothing', async () => {
  const { world, adapter, capture } = linear(seedOf(DEFAULT_STATES, TWO_TICKETS));
  const related = await adapter.relate('ADW-1', { kind: 'blocks', to: 'ADW-2' });
  expect(parseIssues(Related, related)).toEqual([]);
  expect([related.kind, related.to, related.state]).toEqual(['blocks', 'ADW-2', { type: 'unstarted', name: 'Todo' }]);
  expect(world.operations()).toEqual(['SailTicket', 'SailTicket', 'SailRelate']);
  expect(world.requests[2]?.variables).toEqual({ id: 'issue-1', relatedId: 'issue-2', type: 'blocks' });
  expect(capture.events).toEqual([
    { type: 'ticket:related', ticketKey: 'ADW-1', kind: 'blocks', to: 'ADW-2', state: related.state },
  ]);
  const read = await adapter.get('ADW-2');
  expect(read.links.map((link) => link.url)).toEqual([URL_OF('ADW-1')]);
});

test('relate with duplicate moves the ticket to the first duplicate-type state, or else the first canceled-type one, whatever they are called', async () => {
  const defaults = linear(seedOf(DEFAULT_STATES, TWO_TICKETS));
  const renamed = linear(
    seedOf(RENAMED_STATES, [
      { number: 1, title: 'One', state: 'Ready', labels: [] },
      { number: 2, title: 'Two', state: 'Ready', labels: [] },
    ]),
  );
  const first = await defaults.adapter.relate('ADW-1', { kind: 'duplicate', to: 'ADW-2' });
  const second = await renamed.adapter.relate('ADW-1', { kind: 'duplicate', to: 'ADW-2' });
  expect([first.state, second.state]).toEqual([
    { type: 'canceled', name: 'Duplicate' },
    { type: 'canceled', name: 'Dropped' },
  ]);
  expect(defaults.world.operations()).toEqual(['SailTicket', 'SailTicket', 'SailTeam', 'SailRelate', 'SailMove']);
  expect(defaults.world.requests[4]?.variables).toEqual({ id: 'issue-1', stateId: 'state-duplicate' });
  expect(defaults.world.ticket(1).state).toBe('Duplicate');
  expect(renamed.world.ticket(1).state).toBe('Dropped');
});

test('relate with duplicate on a team with neither state is invalid, naming the team, and sends no SailRelate; a ticket already canceled is not moved again', async () => {
  const none = linear(
    seedOf(
      [
        { id: 'state-todo', name: 'Todo', type: 'unstarted', position: 0 },
        { id: 'state-done', name: 'Done', type: 'completed', position: 1 },
      ],
      TWO_TICKETS,
    ),
  );
  const error = await rejection(none.adapter.relate('ADW-1', { kind: 'duplicate', to: 'ADW-2' }));
  expect(failure(error)).toEqual([
    { port: 'ticketSource', op: 'relate', code: 'invalid' },
    'ticketSource.relate: team ADW has no state for duplicate',
  ]);
  expect(none.world.operations()).not.toContain('SailRelate');
  expect(none.capture.events).toEqual([]);

  const closed = linear(
    seedOf(DEFAULT_STATES, [
      { number: 1, title: 'One', state: 'Canceled', labels: [] },
      { number: 2, title: 'Two', state: 'Todo', labels: [] },
    ]),
  );
  const done = await closed.adapter.relate('ADW-1', { kind: 'duplicate', to: 'ADW-2' });
  expect(done.state).toEqual({ type: 'canceled', name: 'Canceled' });
  expect(closed.world.operations()).not.toContain('SailMove');
});

test('relate of a ticket to itself, or with a kind that isn’t one, is invalid before any request', async () => {
  const { world, adapter } = linear(seedOf(DEFAULT_STATES, TWO_TICKETS));
  const errors = [
    await rejection(adapter.relate('ADW-1', { kind: 'related', to: 'ADW-1' })),
    await rejection(adapter.relate('ADW-1', { kind: 'twin' as never, to: 'ADW-2' })),
  ];
  expect(errors.map(portFailure)).toEqual([
    { port: 'ticketSource', op: 'relate', code: 'invalid' },
    { port: 'ticketSource', op: 'relate', code: 'invalid' },
  ]);
  expect(world.operations()).toEqual([]);
});

test('relate answering success: false is a conflict, and emits nothing', async () => {
  const { world, adapter, capture } = linear(seedOf(DEFAULT_STATES, TWO_TICKETS));
  world.failNext('SailRelate', {
    status: 200,
    body: { data: { issueRelationCreate: { success: false, issueRelation: null } } },
  });
  const error = await rejection(adapter.relate('ADW-1', { kind: 'related', to: 'ADW-2' }));
  expect([portFailure(error), capture.events]).toEqual([{ port: 'ticketSource', op: 'relate', code: 'conflict' }, []]);
});

test('create in a team Linear doesn’t have is not_found, and Linear answering success: false to it is a conflict; neither emits', async () => {
  const missing = linear(seedOf(RENAMED_STATES, []));
  const other = createLinearTicketSource({
    team: 'XYZ',
    endpoint: LINEAR_ENDPOINT,
    apiKey: KEY,
    fetch: missing.world.fetch,
    emit: missing.capture.emit,
  });
  const { world, adapter, capture } = linear();
  world.failNext('SailCreate', { status: 200, body: { data: { issueCreate: { success: false, issue: null } } } });
  const errors = [
    await rejection(other.create({ title: 'a', description: 'b', labels: [] })),
    await rejection(adapter.create({ title: 'a', description: 'b', labels: [] })),
  ];
  expect([errors.map(failure), missing.capture.events, capture.events]).toEqual([
    [
      [{ port: 'ticketSource', op: 'create', code: 'not_found' }, 'ticketSource.create: Linear has no team XYZ'],
      [
        { port: 'ticketSource', op: 'create', code: 'conflict' },
        'ticketSource.create: Linear did not create the ticket in team ADW',
      ],
    ],
    [],
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

test('attach asks fileUpload for a signed URL, PUTs the bytes there with the signed headers, its content type and a long cache, then attaches the asset URL under its title, and emits ticket:attached', async () => {
  const { world, adapter, capture } = linear();
  const attached = await adapter.attach('ADW-1', { ...FILE, title: 'Run view' });
  expect(world.operations()).toEqual(['SailTicket', 'SailUpload', 'upload', 'SailAttach']);
  expect(world.requests[1]?.variables).toEqual({ contentType: 'image/png', filename: 'run view.png', size: 8 });
  const [upload] = world.uploads;
  expect(upload?.url).toBe('https://uploads.linear.test/upload/1/run%20view.png');
  expect([upload?.headers['content-type'], upload?.headers['cache-control']]).toEqual([
    'image/png',
    'public, max-age=31536000',
  ]);
  expect([...(upload?.bytes ?? [])]).toEqual([...FILE.bytes]);
  // The API key goes to Linear's GraphQL alone, never to the storage host.
  expect(upload?.headers.authorization).toBeUndefined();
  expect(world.requests[3]?.variables).toEqual({
    issueId: 'issue-1',
    url: 'https://uploads.linear.test/assets/1/run%20view.png',
    title: 'Run view',
  });
  expect(attached.url).toBe('https://uploads.linear.test/assets/1/run%20view.png');
  expect(world.ticket(1).attachments?.at(-1)).toEqual({ title: 'Run view', url: attached.url });
  expect(capture.events).toEqual([
    {
      type: 'ticket:attached',
      ticketKey: 'ADW-1',
      name: 'Run view',
      contentType: 'image/png',
      size: 8,
      url: attached.url,
    },
  ]);
  expect(eventIssues(capture.stamped('publish#1/open'))).toEqual([]);
});

test('a PUT the storage refuses is forbidden for a 403 and unavailable for a 500, with its status and words, and attaches nothing: no SailAttach is sent and nothing is emitted', async () => {
  const errors = [];
  for (const status of [403, 500]) {
    const { world, adapter, capture } = linear();
    world.failNext('upload', { status, body: status === 403 ? 'SignatureDoesNotMatch' : '' });
    errors.push(failure(await rejection(adapter.attach('ADW-1', FILE))));
    expect([world.operations(), capture.events]).toEqual([['SailTicket', 'SailUpload', 'upload'], []]);
  }
  expect(errors).toEqual([
    [
      { port: 'ticketSource', op: 'attach', code: 'forbidden' },
      "ticketSource.attach: Linear's upload host uploads.linear.test refused the file: 403 SignatureDoesNotMatch",
    ],
    [
      { port: 'ticketSource', op: 'attach', code: 'unavailable' },
      "ticketSource.attach: Linear's upload host uploads.linear.test refused the file: 500",
    ],
  ]);
});

test('a PUT that never reaches the storage is unavailable, naming the host and why', async () => {
  const { world } = linear();
  const fetch: Fetch = (input, init) =>
    init.method === 'PUT' ? Promise.reject(new TypeError('connection refused')) : world.fetch(input, init);
  const adapter = createLinearTicketSource({ team: 'ADW', endpoint: LINEAR_ENDPOINT, apiKey: KEY, fetch });
  expect(failure(await rejection(adapter.attach('ADW-1', FILE)))).toEqual([
    { port: 'ticketSource', op: 'attach', code: 'unavailable' },
    "ticketSource.attach: Linear's upload host uploads.linear.test is unreachable: connection refused",
  ]);
});

test('Linear answering success: false to fileUpload or to attachmentCreate is a conflict naming the file, and emits nothing', async () => {
  const errors = [];
  for (const [operation, data] of [
    ['SailUpload', { fileUpload: { success: false, uploadFile: null } }],
    ['SailAttach', { attachmentCreate: { success: false, attachment: null } }],
  ] as const) {
    const { world, adapter, capture } = linear();
    world.failNext(operation, { status: 200, body: { data } });
    errors.push(failure(await rejection(adapter.attach('ADW-1', FILE))));
    expect(capture.events).toEqual([]);
  }
  expect(errors).toEqual([
    [
      { port: 'ticketSource', op: 'attach', code: 'conflict' },
      'ticketSource.attach: Linear gave no upload URL for run view.png',
    ],
    [
      { port: 'ticketSource', op: 'attach', code: 'conflict' },
      'ticketSource.attach: Linear did not attach run view.png to ADW-1',
    ],
  ]);
});
