// The fake TicketSource: the port suite over a copy of the fixture seed, then what only the fake does (D1, D8, D14).
import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeTicketSource } from '../../../src/adapters/fake/ticket-source';
import type { Ticket, TicketMove, TicketState } from '../../../src/ports/types';
import { messageOf, portFailure, rejection } from '../../helpers/ports';
import { ticketSourceSuite } from '../../ports/ticket-source.suite';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures');
const SEED = join(FIXTURES, 'repo', '.sail', 'fake', 'tickets.json');
const GOLDEN_TICKET = join(FIXTURES, 'runs', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N', '00-intake', 'call-1', 'ticket.json');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-fake-tickets-'));
  dirs.push(dir);
  return dir;
}

/** A copy of the fixture seed, and a state file in a folder that doesn't exist yet. */
function files(): { seed: string; state: string } {
  const dir = tempDir();
  const seed = join(dir, 'tickets.json');
  copyFileSync(SEED, seed);
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
  adapter: createFakeTicketSource({ ...files(), emit }),
  world: {
    label: 'sail',
    designated: 'FAKE-1',
    started: 'FAKE-2',
    undesignated: 'FAKE-3',
    missing: 'FAKE-99',
    refs: [
      ['FAKE-1', 'FAKE-1'],
      ['fake://tickets/FAKE-12', 'FAKE-12'],
    ],
  },
}));

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('a claim made through one instance is read by a new one on the same state file, and the seed is unchanged', async () => {
  const world = files();
  const seed = readFileSync(world.seed, 'utf8');
  await createFakeTicketSource(world).claim('FAKE-1');

  const next = createFakeTicketSource(world);
  expect((await next.get('FAKE-1')).state).toEqual({ type: 'started', name: 'In Progress' });
  expect(keys(await next.listDesignated('sail'))).toEqual([]);
  expect(readFileSync(world.seed, 'utf8')).toBe(seed);
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ("the fixture seed's FAKE-1 is the golden ticket, read without creating the state file", async () => {
  const state = join(tempDir(), 'tickets.json');
  const source = createFakeTicketSource({ seed: SEED, state });
  const { title, description, url, labels, comments } = await source.get('FAKE-1');
  const golden = JSON.parse(readFileSync(GOLDEN_TICKET, 'utf8'));
  expect({ title, description, url, labels, comments }).toEqual({
    title: golden.title,
    description: golden.description,
    url: golden.url,
    labels: golden.labels,
    comments: golden.comments,
  });
  expect(keys(await source.listDesignated('sail'))).toEqual(['FAKE-1']);
  expect(existsSync(state)).toBe(false);
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('listDesignated lists only designated unstarted tickets, in ticket-key order', async () => {
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

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ("a seed that isn't JSON, or holds a ticket without a title, is invalid, naming the file", async () => {
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

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ("the fake supports all four moves, and each lands on the fake's state of that name", async () => {
  const source = createFakeTicketSource(files());
  const moves: TicketMove[] = ['unstarted', 'in-progress', 'in-review', 'done'];
  expect(source.capabilities()).toEqual({ comments: true, links: true, attachments: true, moves });
  const states: TicketState[] = [];
  for (const move of moves) states.push((await source.update('FAKE-1', { state: move })).state);
  expect(states).toEqual([
    { type: 'unstarted', name: 'Todo' },
    { type: 'started', name: 'In Progress' },
    { type: 'started', name: 'In Review' },
    { type: 'completed', name: 'Done' },
  ]);
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ("a comment is sail's, numbered after the ticket's own comments", async () => {
  const source = createFakeTicketSource(files());
  const posted = await source.comment('FAKE-1', 'Pull request opened.');
  expect({ id: posted.id, url: posted.url }).toEqual({ id: 'comment-2', url: 'fake://tickets/FAKE-1#comment-2' });
  const { author, body } = (await source.get('FAKE-1')).comments.at(-1) ?? {};
  expect({ author, body }).toEqual({ author: 'sail', body: 'Pull request opened.' });
});

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('parseKey takes a FAKE ticket key or its fake:// URL, whole, and nothing else', () => {
  const source = createFakeTicketSource(files());
  const refs = ['FAKE-7', 'fake://tickets/FAKE-7', 'ADW-7', 'FAKE-7x', 'fake://tickets/FAKE-7/x', 'https://example.com/FAKE-7'];
  expect(refs.map((ref) => source.parseKey(ref))).toEqual(['FAKE-7', 'FAKE-7', undefined, undefined, undefined, undefined]);
});
