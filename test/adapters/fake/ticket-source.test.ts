// The fake TicketSource: the port suite over a copy of the fixture seed, then what only the fake does (D1, D8, D14).
import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeTicketSource } from '../../../src/adapters/fake/ticket-source';
import { Created, type Ticket, type TicketMove, type TicketState } from '../../../src/ports/types';
import { captureEvents, eventIssues, messageOf, parseIssues, portFailure, rejection } from '../../helpers/ports';
import { ticketSourceSuite } from '../../ports/ticket-source.suite';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures');
const SEED = join(FIXTURES, 'repo', '.sail', 'fake', 'tickets.json');
const GOLDEN_TICKET = join(
  FIXTURES,
  'runs',
  'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N',
  '00-intake',
  'call-1',
  'out',
  'ticket.json',
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-fake-tickets-'));
  dirs.push(dir);
  return dir;
}

/** A copy of the fixture seed, naming the labels its team has when `labels` is given, and a state file in a folder that doesn't exist yet. */
function files(labels?: string[]): { seed: string; state: string } {
  const dir = tempDir();
  const seed = join(dir, 'tickets.json');
  if (labels === undefined) copyFileSync(SEED, seed);
  else writeFileSync(seed, JSON.stringify({ labels, ...JSON.parse(readFileSync(SEED, 'utf8')) }));
  return { seed, state: join(dir, 'state', 'tickets.json') };
}

/** A seed holding `tickets`, each with nothing but its key, state and labels of its own. */
function seedOf(tickets: { ticketKey: string; state: TicketState; labels: string[] }[]): string {
  const seed = join(tempDir(), 'tickets.json');
  const full = tickets.map((ticket) => ({
    ...ticket,
    title: `Ticket ${ticket.ticketKey}`,
    description: '',
    comments: [],
    links: [],
    attachments: [],
  }));
  writeFileSync(seed, JSON.stringify({ tickets: full }));
  return seed;
}

const keys = (tickets: readonly Ticket[]): string[] => tickets.map((ticket) => ticket.ticketKey);

ticketSourceSuite('fake', async (emit) => ({
  adapter: createFakeTicketSource({ ...files(['sail', 'cli', 'Bug']), emit }),
  world: {
    label: 'sail',
    designated: 'FAKE-1',
    started: 'FAKE-2',
    undesignated: 'FAKE-3',
    missing: 'FAKE-99',
    spareLabel: 'Bug',
    unknownLabel: 'no-such-label',
    refs: [
      ['FAKE-1', 'FAKE-1'],
      ['fake://tickets/FAKE-12', 'FAKE-12'],
    ],
  },
}));

test("addLabel gives the label in the team's own spelling, however it is written, and adds nothing the ticket carries under another case", async () => {
  const source = createFakeTicketSource(files(['sail', 'cli', 'Bug']));
  expect(source.scope).toBeUndefined();
  expect((await source.addLabel('FAKE-1', 'bug')).labels).toEqual(['sail', 'Bug']);
  expect((await source.addLabel('FAKE-1', 'BUG')).labels).toEqual(['sail', 'Bug']);
  expect((await source.removeLabel('FAKE-1', 'SAIL')).labels).toEqual(['Bug']);
});

test('a seed without labels knows every label: addLabel adds any name, and a change made through one instance is read by the next', async () => {
  const world = files();
  const source = createFakeTicketSource(world);
  expect((await source.addLabel('FAKE-3', 'anything-at-all')).labels).toEqual(['anything-at-all']);
  expect((await createFakeTicketSource(world).get('FAKE-3')).labels).toEqual(['anything-at-all']);
});

test("an unknown label's refusal says which label it is: no label <name>", async () => {
  const source = createFakeTicketSource(files(['sail']));
  const error = await rejection(source.addLabel('FAKE-1', 'no-such-label'));
  expect([portFailure(error), messageOf(error)]).toEqual([
    { port: 'ticketSource', op: 'addLabel', code: 'invalid' },
    'ticketSource.addLabel: no label no-such-label',
  ]);
});

test('a claim made through one instance is read by a new one on the same state file, and the seed is unchanged', async () => {
  const world = files();
  const seed = readFileSync(world.seed, 'utf8');
  await createFakeTicketSource(world).claim('FAKE-1');

  const next = createFakeTicketSource(world);
  expect((await next.get('FAKE-1')).state).toEqual({ type: 'started', name: 'In Progress' });
  expect(keys(await next.listDesignated('sail'))).toEqual([]);
  expect(readFileSync(world.seed, 'utf8')).toBe(seed);
});

test("the fixture seed's FAKE-1 is the golden ticket before its run's claim commented on it, read without creating the state file", async () => {
  const state = join(tempDir(), 'tickets.json');
  const source = createFakeTicketSource({ seed: SEED, state });
  const { title, description, url, labels, comments } = await source.get('FAKE-1');
  const golden = JSON.parse(readFileSync(GOLDEN_TICKET, 'utf8'));
  expect({ title, description, url, labels, comments }).toEqual({
    title: golden.title,
    description: golden.description,
    url: golden.url,
    labels: golden.labels,
    comments: golden.comments.slice(0, -1),
  });
  expect(golden.comments.at(-1)).toMatchObject({
    author: 'sail',
    body: 'sail run FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N started',
  });
  expect(keys(await source.listDesignated('sail'))).toEqual(['FAKE-1']);
  expect(existsSync(state)).toBe(false);
});

test('listDesignated lists only designated unstarted tickets, in ticket-key order', async () => {
  const todo: TicketState = { type: 'unstarted', name: 'Todo' };
  const seed = seedOf([
    { ticketKey: 'FAKE-10', state: todo, labels: ['sail'] },
    { ticketKey: 'FAKE-2', state: { type: 'unstarted', name: 'Backlog' }, labels: ['sail', 'cli'] },
    { ticketKey: 'FAKE-3', state: { type: 'completed', name: 'Done' }, labels: ['sail'] },
    { ticketKey: 'FAKE-4', state: { type: 'canceled', name: 'Canceled' }, labels: ['sail'] },
    { ticketKey: 'FAKE-5', state: todo, labels: ['other'] },
  ]);
  const source = createFakeTicketSource({ seed, state: join(tempDir(), 'state.json') });
  expect(keys(await source.listDesignated('sail'))).toEqual(['FAKE-2', 'FAKE-10']);
});

test("a seed that isn't JSON, or holds a ticket without a title, is invalid, naming the file", async () => {
  const dir = tempDir();
  const notJson = join(dir, 'not-json.json');
  writeFileSync(notJson, '{ "tickets": [');
  const untitled = seedOf([{ ticketKey: 'FAKE-1', state: { type: 'unstarted', name: 'Todo' }, labels: [] }]);
  const text = JSON.parse(readFileSync(untitled, 'utf8'));
  delete text.tickets[0].title;
  writeFileSync(untitled, JSON.stringify(text));

  const errors = [
    await rejection(createFakeTicketSource({ seed: notJson, state: join(dir, 'state.json') }).get('FAKE-1')),
    await rejection(createFakeTicketSource({ seed: untitled, state: join(dir, 'state.json') }).get('FAKE-1')),
  ];
  expect(errors.map(portFailure)).toEqual([
    { port: 'ticketSource', op: 'read', code: 'invalid' },
    { port: 'ticketSource', op: 'read', code: 'invalid' },
  ]);
  expect(messageOf(errors[0])).toStartWith(`ticketSource.read: ${notJson}: `);
  expect(messageOf(errors[1])).toStartWith(`ticketSource.read: ${untitled}: `);
  expect(messageOf(errors[1])).toContain('title');
});

test("the fake supports all five moves, and each lands on the fake's state of that name", async () => {
  const source = createFakeTicketSource(files());
  const moves: TicketMove[] = ['unstarted', 'in-progress', 'in-review', 'done', 'canceled'];
  expect(source.capabilities()).toEqual({ comments: true, links: true, attachments: true, moves });
  const states: TicketState[] = [];
  for (const move of moves) states.push((await source.update('FAKE-1', { state: move })).state);
  expect(states).toEqual([
    { type: 'unstarted', name: 'Todo' },
    { type: 'started', name: 'In Progress' },
    { type: 'started', name: 'In Review' },
    { type: 'completed', name: 'Done' },
    { type: 'canceled', name: 'Canceled' },
  ]);
});

test("a comment is sail's, numbered after the ticket's own comments", async () => {
  const source = createFakeTicketSource(files());
  const posted = await source.comment('FAKE-1', 'Pull request opened.');
  expect({ id: posted.id, url: posted.url }).toEqual({ id: 'comment-2', url: 'fake://tickets/FAKE-1#comment-2' });
  const { author, body } = (await source.get('FAKE-1')).comments.at(-1) ?? {};
  expect({ author, body }).toEqual({ author: 'sail', body: 'Pull request opened.' });
});

test('parseKey takes a FAKE ticket key or its fake:// URL, whole, and nothing else', () => {
  const source = createFakeTicketSource(files());
  const refs = [
    'FAKE-7',
    'fake://tickets/FAKE-7',
    'ADW-7',
    'FAKE-7x',
    'fake://tickets/FAKE-7/x',
    'https://example.com/FAKE-7',
  ];
  expect(refs.map((ref) => source.parseKey(ref))).toEqual([
    'FAKE-7',
    'FAKE-7',
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test('create files a ticket keyed one past the highest FAKE number, unstarted in Todo with its labels and nothing else, and emits ticket:created', async () => {
  const todo: TicketState = { type: 'unstarted', name: 'Todo' };
  const seed = seedOf([
    { ticketKey: 'FAKE-2', state: todo, labels: [] },
    { ticketKey: 'FAKE-10', state: { type: 'completed', name: 'Done' }, labels: ['sail'] },
  ]);
  const state = join(tempDir(), 'state.json');
  const capture = captureEvents();
  const source = createFakeTicketSource({ seed, state, emit: capture.emit });
  const created = await source.create({ title: 'Follow up', description: 'Do the rest.', labels: ['sail', 'bug'] });
  expect(parseIssues(Created, created)).toEqual([]);
  expect({ ticketKey: created.ticketKey, url: created.url }).toEqual({
    ticketKey: 'FAKE-11',
    url: 'fake://tickets/FAKE-11',
  });
  const { raw: _, ...ticket } = await createFakeTicketSource({ seed, state }).get('FAKE-11');
  expect(ticket).toEqual({
    ticketKey: 'FAKE-11',
    title: 'Follow up',
    url: 'fake://tickets/FAKE-11',
    description: 'Do the rest.',
    state: todo,
    labels: ['sail', 'bug'],
    comments: [],
    links: [],
    attachments: [],
  });
  expect(capture.events).toEqual([
    { type: 'ticket:created', ticketKey: 'FAKE-11', title: 'Follow up', url: 'fake://tickets/FAKE-11' },
  ]);
  expect(eventIssues(capture.stamped('publish#1/open'))).toEqual([]);
  expect(eventIssues(capture.stamped())).toEqual([]);
});

test('a second create on a new instance numbers after the first, and a create in an empty world is FAKE-1', async () => {
  const world = {
    seed: seedOf([{ ticketKey: 'FAKE-3', state: { type: 'unstarted', name: 'Todo' }, labels: [] }]),
    state: join(tempDir(), 'state.json'),
  };
  await createFakeTicketSource(world).create({ title: 'One', description: 'a', labels: [] });
  const second = await createFakeTicketSource(world).create({ title: 'Two', description: 'b', labels: [] });
  expect(second.ticketKey).toBe('FAKE-5');

  const empty = createFakeTicketSource({ seed: seedOf([]), state: join(tempDir(), 'state.json') });
  expect((await empty.create({ title: 'First', description: 'c', labels: [] })).ticketKey).toBe('FAKE-1');
});

// pickUp: the states a designated ticket is picked up from.

const TODO_STATE: TicketState = { type: 'unstarted', name: 'Todo' };
const BACKLOG_STATE: TicketState = { type: 'unstarted', name: 'Backlog' };

function pickingUp(pickUp: string[]) {
  const seed = seedOf([
    { ticketKey: 'FAKE-1', state: TODO_STATE, labels: ['sail'] },
    { ticketKey: 'FAKE-2', state: BACKLOG_STATE, labels: ['sail'] },
  ]);
  return createFakeTicketSource({ seed, state: join(tempDir(), 'state.json'), pickUp });
}

test('with pickUp [Todo], listDesignated gives the Todo ticket and not the Backlog one', async () => {
  expect(keys(await pickingUp(['Todo']).listDesignated('sail'))).toEqual(['FAKE-1']);
});

test('with pickUp [Todo], canPickUp holds for a Todo ticket and not for a Backlog one, and without pickUp for both', async () => {
  const picky = pickingUp(['Todo']);
  const [todo, backlog] = await Promise.all([picky.get('FAKE-1'), picky.get('FAKE-2')]);
  const open = createFakeTicketSource({
    seed: seedOf([]),
    state: join(tempDir(), 'state.json'),
  });
  expect([picky.canPickUp(todo), picky.canPickUp(backlog), open.canPickUp(backlog)]).toEqual([true, false, true]);
});

test('with pickUp [Todo], claiming the Backlog ticket takes nothing and changes nothing, and claiming the Todo one takes', async () => {
  const source = pickingUp(['Todo']);
  const refused = await source.claim('FAKE-2');
  expect([refused.claimed, refused.state, (await source.get('FAKE-2')).state]).toEqual([
    false,
    BACKLOG_STATE,
    BACKLOG_STATE,
  ]);
  expect((await source.claim('FAKE-1')).claimed).toBe(true);
});

test('with pickUp [Backlog, Todo], the unstarted move lands on Backlog, and without pickUp on Todo', async () => {
  const picky = pickingUp(['Backlog', 'Todo']);
  expect((await picky.update('FAKE-1', { state: 'unstarted' })).state).toEqual(BACKLOG_STATE);
  const open = createFakeTicketSource(files());
  expect((await open.update('FAKE-1', { state: 'unstarted' })).state).toEqual(TODO_STATE);
});

test('a seeded priority comes back from get and listDesignated, and a seed without one returns no priority', async () => {
  const seed = join(tempDir(), 'tickets.json');
  const ticket = (ticketKey: string, extra: object) => ({
    ticketKey,
    title: ticketKey,
    description: '',
    state: { type: 'unstarted', name: 'Todo' },
    labels: ['sail'],
    comments: [],
    links: [],
    attachments: [],
    ...extra,
  });
  writeFileSync(seed, JSON.stringify({ tickets: [ticket('FAKE-1', { priority: 'high' }), ticket('FAKE-2', {})] }));
  const source = createFakeTicketSource({ seed, state: join(tempDir(), 'state.json') });
  expect((await source.get('FAKE-1')).priority).toBe('high');
  expect('priority' in (await source.get('FAKE-2'))).toBe(false);
  expect((await source.listDesignated('sail')).map((each) => [each.ticketKey, each.priority])).toEqual([
    ['FAKE-1', 'high'],
    ['FAKE-2', undefined],
  ]);
});
