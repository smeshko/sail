// resolveSource() and claimSource(): a run's source checked, then claimed, on the fake TicketSource over a seed with
// one ticket per pairing of label and state. A wrapper records the port's calls, and can make one fail or answer
// otherwise, which is how a lost race and a failing provider are told apart from the fake's own answers.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeTicketSource } from '../../src/adapters/fake/ticket-source';
import type { Forced } from '../../src/engine/run-dir';
import { claimComment, claimedBy, claimSource, resolveSource } from '../../src/engine/source';
import { PortError } from '../../src/ports/errors';
import type { TicketSource } from '../../src/ports/ticket-source';
import type { Ticket, TicketState } from '../../src/ports/types';
import { rejection } from '../helpers/ports';

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

test.each<[string, string, boolean, Forced[]]>([
  ['a designated, unstarted ticket', 'FAKE-1', false, []],
  ['a designated, unstarted ticket, forced', 'FAKE-1', true, []],
  ['an undesignated ticket, forced', 'FAKE-3', true, ['designation']],
  ['a started ticket, forced', 'FAKE-2', true, ['state']],
  ['a canceled ticket, forced', 'FAKE-4', true, ['state']],
  ['a completed ticket, forced', 'FAKE-6', true, ['state']],
  ['an undesignated, completed ticket, forced', 'FAKE-5', true, ['designation', 'state']],
])(
  '%s resolves to its key and the ticket fetched, listing the checks --force overrode: designation, then state',
  async (_, ticketKey, force, forced) => {
    const { source, calls, state, fake } = world();
    const resolved = await resolveSource({ ref: ticketKey, ticketSource: source, label: 'sail', force });
    expect(resolved).toEqual({ ticketKey, ticket: await fake.get(ticketKey), forced });
    expect([calls, existsSync(state)]).toEqual([['parseKey', 'get'], false]);
  },
);

test('a URL the ticket source owns resolves to the ticket key it names, and the ticket is fetched by that key', async () => {
  const { source, fake } = world();
  const resolved = await resolveSource({ ref: 'fake://tickets/FAKE-1', ticketSource: source, label: 'sail' });
  expect(resolved).toEqual({ ticketKey: 'FAKE-1', ticket: await fake.get('FAKE-1'), forced: [] });
});

test.each([['FAKE1'], ['run'], ['']])(
  "'%s', which the ticket source does not parse, is refused in its own sentence before anything is fetched",
  async (ref) => {
    const { source, calls } = world();
    const refused = await resolveSource({ ref, ticketSource: source, label: 'sail', force: true });
    expect([refused, calls]).toEqual([{ refused: NOT_A_TICKET(ref) }, ['parseKey']]);
  },
);

test("a ticket the ticket source does not have is refused with the port's message and its code", async () => {
  const { source } = world();
  expect(await resolveSource({ ref: 'FAKE-9', ticketSource: source, label: 'sail', force: true })).toEqual({
    refused: 'ticketSource.get: no ticket FAKE-9 (not_found)',
  });
});

test('an answer of get that is no Ticket is refused as invalid, saying where it is none', async () => {
  const { source, fake } = world({ get: async (key) => ({ ...(await fake.get(key)), title: 7 }) as unknown as Ticket });
  expect(await resolveSource({ ref: 'FAKE-1', ticketSource: source, label: 'sail' })).toEqual({
    refused:
      'ticketSource.get: ticket FAKE-1 is not a Ticket: title Invalid input: expected string, received number (invalid)',
  });
});

test('an unstarted ticket outside the pick-up states is refused with its own text unless forced', async () => {
  const { source } = world();
  const picky: TicketSource = { ...source, canPickUp: () => false };
  const refused = await resolveSource({ ref: 'FAKE-1', ticketSource: picky, label: 'sail' });
  const forced = await resolveSource({ ref: 'FAKE-1', ticketSource: picky, label: 'sail', force: true });
  expect([refused, 'refused' in forced]).toEqual([
    { refused: 'the ticket is not in a pick-up state: it is Todo. --force runs it anyway' },
    false,
  ]);
});

test.each<[string, string, string, string]>([
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

test('anything get throws that is no PortError is thrown on: a bug, never a refusal', async () => {
  const { source } = world({ get: broken });
  const thrown = await rejection(resolveSource({ ref: 'FAKE-1', ticketSource: source, label: 'sail' }));
  expect(thrown).toBeInstanceOf(TypeError);
});

// claimSource(): the claim the ticket intake makes, then the comment with the run id.

const COMMENT = `sail run ${RUN_ID} started`;
const claim = (ticketKey: string, source: TicketSource, forced: Forced[] = []) =>
  claimSource({ ticketKey, runId: RUN_ID, ticketSource: source, forced });

test('an unstarted ticket is claimed and commented on with the run id, with no update, and the record says it took', async () => {
  const { source, calls, fake } = world();
  expect(await claim('FAKE-1', source)).toEqual({ claimed: true, state: IN_PROGRESS });
  expect(calls).toEqual(['claim', 'comment']);
  const ticket = await fake.get('FAKE-1');
  expect([ticket.state, ticket.comments]).toEqual([
    IN_PROGRESS,
    [{ author: 'sail', body: COMMENT, createdAt: NOW.toISOString() }],
  ]);
});

test('a ticket whose claim did not take, unforced, throws a conflict PortError with the lost-claim text, and is neither moved nor commented on', async () => {
  const { source, calls, fake } = world();
  const thrown = await rejection(claim('FAKE-2', source));
  expect(thrown).toBeInstanceOf(PortError);
  expect(thrown).toMatchObject({
    port: 'ticketSource',
    op: 'claim',
    code: 'conflict',
    message:
      'ticketSource.claim: the ticket is already claimed: it became In Progress while sail was starting. --force runs it anyway',
  });
  expect(calls).toEqual(['claim', 'get']);
  expect((await fake.get('FAKE-2')).comments).toEqual([]);
});

test.each([DONE, CANCELED])('a lost claim on $name says the ticket is not unstarted', async (state) => {
  const { source } = world({ claim: async () => ({ claimed: false, state, raw: null }) });
  expect(await rejection(claim('FAKE-1', source))).toMatchObject({
    code: 'conflict',
    message: `ticketSource.claim: the ticket is not unstarted: it became ${state.name} while sail was starting. --force runs it anyway`,
  });
});

test('a ticket claimed by another run is lost even when its latest claim comment names that run', async () => {
  const { source, fake } = world();
  await fake.claim('FAKE-1');
  await fake.comment('FAKE-1', claimComment('FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3O'));
  const thrown = await rejection(claim('FAKE-1', source));
  expect(thrown).toMatchObject({ code: 'conflict' });
  expect((await fake.get('FAKE-1')).comments).toHaveLength(1);
});

test('a claim that did not take on a ticket whose latest claim comment names this run is this run’s own earlier claim: recorded as taken, with no second comment', async () => {
  const { source, calls, fake } = world();
  await fake.claim('FAKE-1');
  await fake.comment('FAKE-1', COMMENT);
  expect(await claim('FAKE-1', source)).toEqual({ claimed: true, state: IN_PROGRESS });
  expect(calls).toEqual(['claim', 'get']);
  expect((await fake.get('FAKE-1')).comments).toHaveLength(1);
});

test.each<[Forced[]]>([[[]], [['state']]])(
  'an earlier claim without a comment is completed without moving it, forced %j',
  async (forced) => {
    const { source, calls, fake } = world();
    await fake.claim('FAKE-1');
    expect(
      await claimSource({ ticketKey: 'FAKE-1', runId: RUN_ID, ticketSource: source, forced, claimedEarlier: true }),
    ).toEqual({ claimed: true, state: IN_PROGRESS });
    expect(calls).toEqual(['claim', 'get', 'comment']);
    expect((await fake.get('FAKE-1')).comments.map(({ body }) => body)).toEqual([COMMENT]);
  },
);

test('an earlier claim is completed despite a previous run’s claim comment', async () => {
  const { source, fake, calls } = world();
  const oldComment = claimComment('FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3M');
  await fake.claim('FAKE-1');
  await fake.comment('FAKE-1', oldComment);
  await fake.update('FAKE-1', { state: 'unstarted' });
  await fake.claim('FAKE-1');
  expect(
    await claimSource({ ticketKey: 'FAKE-1', runId: RUN_ID, ticketSource: source, forced: [], claimedEarlier: true }),
  ).toEqual({ claimed: true, state: IN_PROGRESS });
  expect(calls).toEqual(['claim', 'get', 'comment']);
  expect((await fake.get('FAKE-1')).comments.map(({ body }) => body)).toEqual([oldComment, COMMENT]);
});

test.each(['FAKE-1-other', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3P'])(
  'an earlier claim still loses to another run’s latest claim comment: %s',
  async (owner) => {
    const { source, fake, calls } = world();
    await fake.claim('FAKE-1');
    await fake.comment('FAKE-1', claimComment(owner));
    expect(
      await rejection(
        claimSource({ ticketKey: 'FAKE-1', runId: RUN_ID, ticketSource: source, forced: [], claimedEarlier: true }),
      ),
    ).toMatchObject({ code: 'conflict' });
    expect(calls).toEqual(['claim', 'get']);
    expect((await fake.get('FAKE-1')).comments.map(({ body }) => body)).toEqual([claimComment(owner)]);
  },
);

test.each<[string, string]>([
  ['a started ticket', 'FAKE-2'],
  ['a completed ticket', 'FAKE-6'],
  ['a canceled ticket', 'FAKE-4'],
])(
  'forced for its state, %s is moved to In Progress through update and commented on: the claim is recorded as not taken',
  async (_, ticketKey) => {
    const { source, calls, fake } = world();
    expect(await claim(ticketKey, source, ['state'])).toEqual({ claimed: false, state: IN_PROGRESS });
    expect(calls).toEqual(['claim', 'get', 'update in-progress', 'comment']);
    const ticket = await fake.get(ticketKey);
    expect([ticket.state, ticket.comments.map((comment) => comment.body)]).toEqual([IN_PROGRESS, [COMMENT]]);
  },
);

test('forced for its designation alone, a claim that did not take is still lost', async () => {
  const { source } = world();
  expect(await rejection(claim('FAKE-2', source, ['designation']))).toMatchObject({ code: 'conflict' });
});

/** A state as an adapter may hand it on: the port's two fields, and one of the provider's own. */
const withId = (state: TicketState): TicketState => Object.assign({ id: 'state-7' }, state);

test.each<[string, string, boolean, Forced[]]>([
  ['a claim', 'FAKE-1', true, []],
  ['a forced move', 'FAKE-6', false, ['state']],
])(
  "the state %s answers with is recorded by its type and name alone, whatever else the adapter's answer carries",
  async (_, ticketKey, taken, forced) => {
    const { source, fake } = world({
      claim: async (key) => {
        const answer = await fake.claim(key);
        return { ...answer, state: withId(answer.state) };
      },
      update: async (key, change) => {
        const answer = await fake.update(key, change);
        return { ...answer, state: withId(answer.state) };
      },
    });
    expect(await claim(ticketKey, source, forced)).toEqual({ claimed: taken, state: IN_PROGRESS });
  },
);

test('a claim that fails throws its PortError, and nothing else is called', async () => {
  const { source, calls } = world({ claim: failing('claim', 'the provider is down') });
  const thrown = await rejection(claim('FAKE-1', source, ['state']));
  expect(thrown).toMatchObject({ message: 'ticketSource.claim: the provider is down', code: 'unavailable' });
  expect(calls).toEqual(['claim']);
});

test('a forced move that fails throws its PortError, and no comment is posted', async () => {
  const { source, calls, fake } = world({ update: failing('update', 'the provider is down') });
  const thrown = await rejection(claim('FAKE-6', source, ['state']));
  expect(thrown).toMatchObject({ message: 'ticketSource.update: the provider is down', code: 'unavailable' });
  expect(calls).toEqual(['claim', 'get', 'update in-progress']);
  expect((await fake.get('FAKE-6')).comments).toEqual([]);
});

test.each<[string, string, Forced[]]>([
  ['the claim took', 'FAKE-1', []],
  ['a forced move of a completed ticket', 'FAKE-6', ['state']],
])(
  'a comment that fails after %s throws a PortError saying the state the ticket is in now, the run and why, keeping the code',
  async (_, ticketKey, forced) => {
    const { source, fake } = world({ comment: failing('comment', 'comments are closed') });
    const thrown = await rejection(claim(ticketKey, source, forced));
    expect(thrown).toBeInstanceOf(PortError);
    expect(thrown).toMatchObject({
      op: 'comment',
      code: 'unavailable',
      message: `ticketSource.comment: the ticket is now In Progress, but the comment naming run ${RUN_ID} failed: ticketSource.comment: comments are closed (unavailable). --force runs it`,
    });
    // Nothing is moved back.
    expect((await fake.get(ticketKey)).state).toEqual(IN_PROGRESS);
  },
);

test.each<[string, Partial<Calls>, string]>([
  ['claim', { claim: broken }, 'FAKE-1'],
  ['update', { update: broken }, 'FAKE-2'],
  ['comment', { comment: broken }, 'FAKE-1'],
])('anything %s throws that is no PortError is thrown on: a bug', async (_, instead, ticketKey) => {
  const { source } = world(instead);
  const thrown = await rejection(claim(ticketKey, source, ['state']));
  expect(thrown).toBeInstanceOf(TypeError);
});

const said = (...bodies: string[]) => ({
  comments: bodies.map((body) => ({ author: 'sail', body })),
});

test('claimedBy gives undefined for a ticket with no comments', () => {
  expect(claimedBy(said())).toBeUndefined();
});

test('claimedBy ignores comments that are no claim', () => {
  expect(claimedBy(said('looks good', 'sail run FAKE-1-a opened https://example.test/pr/1'))).toBeUndefined();
});

test('claimedBy gives the latest claim, past a later comment that is no claim', () => {
  const ticket = said(
    claimComment('FAKE-1-first'),
    claimComment('FAKE-1-second'),
    'sail run FAKE-1-second opened https://example.test/pr/1',
  );
  expect(claimedBy(ticket)).toBe('FAKE-1-second');
});

test('claimedBy reads back the run id claimComment wrote', () => {
  expect(claimedBy(said(`  ${claimComment('FAKE-9-xyz')}\n`))).toBe('FAKE-9-xyz');
});

// A fake that picks up from Todo alone, over a Todo and a Backlog ticket, both labelled.

function pickUpWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'sail-source-'));
  dirs.push(dir);
  const seed = join(dir, 'tickets.json');
  const backlog: TicketState = { type: 'unstarted', name: 'Backlog' };
  const tickets = [
    { ticketKey: 'FAKE-1', labels: ['sail'], state: TODO },
    { ticketKey: 'FAKE-2', labels: ['sail'], state: backlog },
  ].map((ticket) => ({
    ...ticket,
    title: `Ticket ${ticket.ticketKey}`,
    description: '',
    comments: [],
    links: [],
    attachments: [],
  }));
  writeFileSync(seed, JSON.stringify({ tickets }));
  return createFakeTicketSource({ seed, state: join(dir, 'state.json'), now: () => NOW, pickUp: ['Todo'] });
}

test('with pickUp [Todo], a start refuses the Backlog ticket, accepts the Todo one, and force accepts the Backlog one, recording state as forced', async () => {
  const source = pickUpWorld();
  const start = (ref: string, force?: boolean) =>
    resolveSource({ ref, ticketSource: source, label: 'sail', ...(force === undefined ? {} : { force }) });
  expect(await start('FAKE-2')).toEqual({
    refused: 'the ticket is not in a pick-up state: it is Backlog. --force runs it anyway',
  });
  expect('refused' in (await start('FAKE-1'))).toBe(false);
  expect(await start('FAKE-1', true)).toMatchObject({ ticketKey: 'FAKE-1', forced: [] });
  expect(await start('FAKE-2', true)).toMatchObject({ ticketKey: 'FAKE-2', forced: ['state'] });
});

test('with pickUp [Todo], a claim of the Backlog ticket with state forced moves it to In Progress, and without it is lost', async () => {
  const source = pickUpWorld();
  const lost = claimSource({ ticketKey: 'FAKE-2', runId: RUN_ID, ticketSource: source, forced: [] });
  expect(await rejection(lost)).toMatchObject({
    code: 'conflict',
    message:
      'ticketSource.claim: the ticket is not in a pick-up state: it became Backlog while sail was starting. --force runs it anyway',
  });
  expect((await source.get('FAKE-2')).state).toEqual({ type: 'unstarted', name: 'Backlog' });
  const claimed = await claimSource({ ticketKey: 'FAKE-2', runId: RUN_ID, ticketSource: source, forced: ['state'] });
  expect([claimed, (await source.get('FAKE-2')).state]).toEqual([{ claimed: false, state: IN_PROGRESS }, IN_PROGRESS]);
});
