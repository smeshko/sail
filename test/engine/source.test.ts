// resolveSource() and claimSource(): a run's source checked, then claimed, on the fake TicketSource over a seed with
// one ticket per pairing of label and state. A wrapper records the port's calls, and can make one fail or answer
// otherwise, which is how a lost race and a failing provider are told apart from the fake's own answers.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeTicketSource } from '../../src/adapters/fake/ticket-source';
import type { Forced } from '../../src/engine/run-dir';
import { claimSource, resolveSource } from '../../src/engine/source';
import { PortError } from '../../src/ports/errors';
import type { TicketSource } from '../../src/ports/ticket-source';
import type { Ticket, TicketState } from '../../src/ports/types';
import { eventIssues, rejection } from '../helpers/ports';

const RUN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const NOW = new Date('2026-10-08T09:00:00.000Z');
const TODO: TicketState = { type: 'unstarted', name: 'Todo' };
const IN_PROGRESS: TicketState = { type: 'started', name: 'In Progress' };
const DONE: TicketState = { type: 'completed', name: 'Done' };
const CANCELED: TicketState = { type: 'canceled', name: 'Canceled' };

/** One ticket per pairing the checks tell apart. */
const SEED = [
  { ticketKey: 'FAKE-1', labels: ['sail'], state: TODO },
  { ticketKey: 'FAKE-2', labels: ['sail'], state: IN_PROGRESS },
  { ticketKey: 'FAKE-3', labels: [], state: TODO },
  { ticketKey: 'FAKE-4', labels: ['sail'], state: CANCELED },
  { ticketKey: 'FAKE-5', labels: [], state: DONE },
  { ticketKey: 'FAKE-6', labels: ['sail'], state: DONE },
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Calls = Pick<TicketSource, 'get' | 'claim' | 'update' | 'comment'>;

/**
 * The fake over `SEED` on a fixed clock, with every call of the port recorded in `calls`. `instead` answers a call in
 * the fake's place. `state` is the fake's state file, which exists only once something was written.
 */
function world(instead: Partial<Calls> = {}): {
  source: TicketSource;
  calls: string[];
  state: string;
  fake: TicketSource;
} {
  const dir = mkdtempSync(join(tmpdir(), 'sail-source-'));
  dirs.push(dir);
  const seed = join(dir, 'tickets.json');
  const tickets = SEED.map((ticket) => ({
    ...ticket,
    title: `Ticket ${ticket.ticketKey}`,
    description: '',
    comments: [],
    links: [],
    attachments: [],
  }));
  writeFileSync(seed, JSON.stringify({ tickets }));
  const state = join(dir, 'state', 'tickets.json');
  const fake = createFakeTicketSource({ seed, state, now: () => NOW });
  const calls: string[] = [];
  const source: TicketSource = {
    ...fake,
    parseKey(ref) {
      calls.push('parseKey');
      return fake.parseKey(ref);
    },
    get(ticketKey) {
      calls.push('get');
      return (instead.get ?? fake.get)(ticketKey);
    },
    claim(ticketKey) {
      calls.push('claim');
      return (instead.claim ?? fake.claim)(ticketKey);
    },
    update(ticketKey, change) {
      calls.push(`update ${change.state}`);
      return (instead.update ?? fake.update)(ticketKey, change);
    },
    comment(ticketKey, body) {
      calls.push('comment');
      return (instead.comment ?? fake.comment)(ticketKey, body);
    },
  };
  return { source, calls, state, fake };
}

const NOT_A_TICKET = (ref: string) =>
  `'${ref}' is not a ticket of the fake ticket source: a ticket key, or a URL it owns`;
const failing = (op: string, message: string) => async (): Promise<never> => {
  throw new PortError('ticketSource', op, 'unavailable', message);
};
const broken = async (): Promise<never> => {
  throw new TypeError('the adapter broke');
};

// resolveSource(): the key, the fetch, the label and the state (D4, D7, D8).

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  .each<[string, string, boolean, Forced[]]>([
  ['a designated, unstarted ticket', 'FAKE-1', false, []],
  ['a designated, unstarted ticket, forced', 'FAKE-1', true, []],
  ['an undesignated ticket, forced', 'FAKE-3', true, ['designation']],
  ['a started ticket, forced', 'FAKE-2', true, []],
  ['a canceled ticket, forced', 'FAKE-4', true, []],
  ['a completed ticket, forced', 'FAKE-6', true, []],
  ['an undesignated, completed ticket, forced', 'FAKE-5', true, ['designation']],
])(
  '%s resolves to its key and the ticket fetched, listing designation only when --force overrode the label',
  async (_, ticketKey, force, forced) => {
    const { source, calls, state, fake } = world();
    const resolved = await resolveSource({ ref: ticketKey, ticketSource: source, label: 'sail', force });
    expect(resolved).toEqual({ ticketKey, ticket: await fake.get(ticketKey), forced });
    expect([calls, existsSync(state)]).toEqual([['parseKey', 'get'], false]);
  },
);

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a URL the ticket source owns resolves to the ticket key it names, and the ticket is fetched by that key', async () => {
  const { source, fake } = world();
  const resolved = await resolveSource({ ref: 'fake://tickets/FAKE-1', ticketSource: source, label: 'sail' });
  expect(resolved).toEqual({ ticketKey: 'FAKE-1', ticket: await fake.get('FAKE-1'), forced: [] });
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  .each([['FAKE1'], ['run'], ['']])(
  "'%s', which the ticket source does not parse, is refused in its own sentence before anything is fetched",
  async (ref) => {
    const { source, calls } = world();
    const refused = await resolveSource({ ref, ticketSource: source, label: 'sail', force: true });
    expect([refused, calls]).toEqual([{ refused: NOT_A_TICKET(ref) }, ['parseKey']]);
  },
);

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ("a ticket the ticket source does not have is refused with the port's message and its code", async () => {
  const { source } = world();
  expect(await resolveSource({ ref: 'FAKE-9', ticketSource: source, label: 'sail', force: true })).toEqual({
    refused: 'ticketSource.get: no ticket FAKE-9 (not_found)',
  });
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('an answer of get that is no Ticket is refused as invalid, saying where it is none', async () => {
  const { source, fake } = world({ get: async (key) => ({ ...(await fake.get(key)), title: 7 }) as unknown as Ticket });
  expect(await resolveSource({ ref: 'FAKE-1', ticketSource: source, label: 'sail' })).toEqual({
    refused:
      'ticketSource.get: ticket FAKE-1 is not a Ticket: title Invalid input: expected string, received number (invalid)',
  });
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  .each<[string, string, string, string]>([
  ['an undesignated ticket', 'FAKE-3', 'sail', "the ticket is not designated: it carries no 'sail' label"],
  [
    'a ticket that carries another label',
    'FAKE-1',
    'sail-api',
    "the ticket is not designated: it carries no 'sail-api' label",
  ],
  ['a started ticket', 'FAKE-2', 'sail', 'the ticket is already claimed: it is In Progress'],
  ['a completed ticket', 'FAKE-6', 'sail', 'the ticket is not unstarted: it is Done'],
  ['a canceled ticket', 'FAKE-4', 'sail', 'the ticket is not unstarted: it is Canceled'],
  [
    'a ticket that fails both checks, for the label',
    'FAKE-5',
    'sail',
    "the ticket is not designated: it carries no 'sail' label",
  ],
])('%s is refused unless forced, and nothing is written', async (_, ticketKey, label, why) => {
  const { source, state } = world();
  const refused = await resolveSource({ ref: ticketKey, ticketSource: source, label });
  expect([refused, existsSync(state)]).toEqual([{ refused: `${why}. --force runs it anyway` }, false]);
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('anything get throws that is no PortError is thrown on: a bug, never a refusal', async () => {
  const { source } = world({ get: broken });
  const thrown = await rejection(resolveSource({ ref: 'FAKE-1', ticketSource: source, label: 'sail' }));
  expect(thrown).toBeInstanceOf(TypeError);
});

// claimSource(): the claim or the forced move, then the comment (D3, D5, D6, D9).

const COMMENT = `sail run ${RUN_ID} started`;
const COMMENTED = { type: 'ticket:commented', ticketKey: 'FAKE-1', body: COMMENT } as const;
/** The events as the bus would stamp them, with no key: the claim belongs to no call. */
const stamped = (events: readonly object[]) =>
  events.map((event, index) => ({ seq: index + 1, ts: NOW.toISOString(), runId: RUN_ID, ...event }));

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('an unstarted ticket is claimed and commented on with the run id, with no update, and the events say both', async () => {
  const { source, calls, fake } = world();
  const claimed = await claimSource({ ticketKey: 'FAKE-1', runId: RUN_ID, ticketSource: source });
  expect(claimed).toEqual({
    claim: { claimed: true, state: IN_PROGRESS },
    forced: [],
    events: [{ type: 'ticket:claimed', ticketKey: 'FAKE-1', state: IN_PROGRESS }, COMMENTED],
  });
  expect(calls).toEqual(['claim', 'comment']);
  const ticket = await fake.get('FAKE-1');
  expect([ticket.state, ticket.comments]).toEqual([
    IN_PROGRESS,
    [{ author: 'sail', body: COMMENT, createdAt: NOW.toISOString() }],
  ]);
  expect(eventIssues(stamped('events' in claimed ? claimed.events : []))).toEqual([]);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a ticket whose claim did not take is refused unless forced, and is neither moved nor commented on', async () => {
  const { source, calls, fake } = world();
  const refused = await claimSource({ ticketKey: 'FAKE-2', runId: RUN_ID, ticketSource: source });
  expect([refused, calls]).toEqual([
    {
      refused: 'the ticket is already claimed: it became In Progress while sail was starting. --force runs it anyway',
    },
    ['claim'],
  ]);
  expect((await fake.get('FAKE-2')).comments).toEqual([]);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  .each<[string, string]>([
  ['a started ticket', 'FAKE-2'],
  ['a completed ticket', 'FAKE-6'],
  ['a canceled ticket', 'FAKE-4'],
])(
  'forced, %s is moved to In Progress through update and commented on: the claim is recorded as not taken, with the state update reported',
  async (_, ticketKey) => {
    const { source, calls, fake } = world();
    const claimed = await claimSource({ ticketKey, runId: RUN_ID, ticketSource: source, force: true });
    expect(claimed).toEqual({
      claim: { claimed: false, state: IN_PROGRESS },
      forced: ['state'],
      events: [
        { type: 'ticket:updated', ticketKey, change: { state: 'in-progress' }, state: IN_PROGRESS },
        { ...COMMENTED, ticketKey },
      ],
    });
    expect(calls).toEqual(['claim', 'update in-progress', 'comment']);
    const ticket = await fake.get(ticketKey);
    expect([ticket.state, ticket.comments.map((comment) => comment.body)]).toEqual([IN_PROGRESS, [COMMENT]]);
    expect(eventIssues(stamped('events' in claimed ? claimed.events : []))).toEqual([]);
  },
);

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a claim that fails is refused with its message and code, and nothing else is called', async () => {
  const { source, calls } = world({ claim: failing('claim', 'the provider is down') });
  const refused = await claimSource({ ticketKey: 'FAKE-1', runId: RUN_ID, ticketSource: source, force: true });
  expect([refused, calls]).toEqual([{ refused: 'ticketSource.claim: the provider is down (unavailable)' }, ['claim']]);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('a forced move that fails is refused with its message and code, and no comment is posted', async () => {
  const { source, calls, fake } = world({ update: failing('update', 'the provider is down') });
  const refused = await claimSource({ ticketKey: 'FAKE-6', runId: RUN_ID, ticketSource: source, force: true });
  expect([refused, calls]).toEqual([
    { refused: 'ticketSource.update: the provider is down (unavailable)' },
    ['claim', 'update in-progress'],
  ]);
  expect((await fake.get('FAKE-6')).comments).toEqual([]);
});

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  .each<[string, string, boolean]>([
  ['the claim took', 'FAKE-1', false],
  ['a forced move of a completed ticket', 'FAKE-6', true],
])(
  'a comment that fails after %s is refused, saying the state the ticket is in now, the run and why',
  async (_, ticketKey, force) => {
    const { source, fake } = world({ comment: failing('comment', 'comments are closed') });
    const refused = await claimSource({ ticketKey, runId: RUN_ID, ticketSource: source, force });
    expect(refused).toEqual({
      refused: `the ticket is now In Progress, but the comment naming run ${RUN_ID} failed: ticketSource.comment: comments are closed (unavailable). --force runs it`,
    });
    // Nothing is moved back.
    expect((await fake.get(ticketKey)).state).toEqual(IN_PROGRESS);
  },
);

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  .each<[string, Partial<Calls>, string]>([
  ['claim', { claim: broken }, 'FAKE-1'],
  ['update', { update: broken }, 'FAKE-2'],
  ['comment', { comment: broken }, 'FAKE-1'],
])('anything %s throws that is no PortError is thrown on: a bug, never a refusal', async (_, instead, ticketKey) => {
  const { source } = world(instead);
  const thrown = await rejection(claimSource({ ticketKey, runId: RUN_ID, ticketSource: source, force: true }));
  expect(thrown).toBeInstanceOf(TypeError);
});
