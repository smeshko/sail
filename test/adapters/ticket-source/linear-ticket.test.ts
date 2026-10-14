// A Linear issue node as the port's Ticket: recorded nodes, written by hand to the shape Linear's GraphQL API answers
// with, normalised by pure functions. Each result is parsed with the port's Ticket schema before it is compared.
import { expect, test } from 'bun:test';
import { toTicket } from '../../../src/adapters/ticket-source/linear-ticket';
import { PortError } from '../../../src/ports/errors';
import { Ticket } from '../../../src/ports/types';
import { caught, parseIssues } from '../../helpers/ports';

const UPLOADS = 'https://uploads.linear.app/0b1c/2d3e';

/** A ticket with everything: comments out of order, a bot's and an authorless one, relations both ways, uploads. */
const NODE = {
  id: 'issue-7',
  identifier: 'ADW-7',
  number: 7,
  title: 'Add a greeting',
  description: `Greet the user by name.\n\n![](${UPLOADS}/mock.png)\n\nSee [the spec](${UPLOADS}/spec.pdf).`,
  url: 'https://linear.app/sail-test/issue/ADW-7/add-a-greeting',
  priority: 2,
  state: { id: 'state-ready', name: 'Ready', type: 'unstarted' },
  team: { key: 'ADW' },
  assignee: { name: 'Ada', email: 'ada@example.com' },
  labels: { nodes: [{ name: 'sail' }, { name: 'cli' }] },
  comments: {
    nodes: [
      {
        id: 'comment-2',
        body: `Same spec: [the spec](${UPLOADS}/spec.pdf), and [run log](${UPLOADS}/run.log).`,
        createdAt: '2026-10-02T09:00:00.000Z',
        user: { name: 'Ada' },
        botActor: null,
      },
      {
        id: 'comment-1',
        body: 'Linked a pull request.',
        createdAt: '2026-10-01T09:00:00.000Z',
        user: null,
        botActor: { name: 'GitHub' },
      },
      {
        id: 'comment-3',
        body: 'Imported from elsewhere.',
        createdAt: '2026-10-03T09:00:00.000Z',
        user: null,
        botActor: null,
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: '2' },
  },
  relations: {
    nodes: [
      {
        type: 'blocks',
        relatedIssue: { identifier: 'ADW-8', title: 'Say goodbye', url: 'https://linear.app/sail-test/issue/ADW-8' },
      },
    ],
  },
  inverseRelations: {
    nodes: [
      {
        type: 'related',
        issue: { identifier: 'ADW-3', title: 'Greeting design', url: 'https://linear.app/sail-test/issue/ADW-3' },
      },
    ],
  },
  attachments: { nodes: [{ title: 'Design doc', url: 'https://example.com/design' }] },
};

/** `NODE` with `changes` over it. */
const nodeWith = (changes: Record<string, unknown>) => ({ ...structuredClone(NODE), ...changes });

/** The ticket from `node` and its own comments, parsed with the port's schema first. */
function ticketOf(node: Record<string, unknown>, op = 'get'): Ticket {
  const ticket = toTicket(node, (node.comments as { nodes: unknown[] }).nodes, op);
  expect(parseIssues(Ticket, ticket)).toEqual([]);
  return ticket;
}

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a full Linear ticket is a Ticket with every field: comments in order with their authors, relations both ways and attachments in links, uploads beside attachments, raw as sent', () => {
  expect(ticketOf(nodeWith({}))).toEqual({
    ticketKey: 'ADW-7',
    title: 'Add a greeting',
    url: 'https://linear.app/sail-test/issue/ADW-7/add-a-greeting',
    description: NODE.description,
    state: { type: 'unstarted', name: 'Ready' },
    labels: ['sail', 'cli'],
    comments: [
      { author: 'GitHub', body: 'Linked a pull request.', createdAt: '2026-10-01T09:00:00.000Z' },
      {
        author: 'Ada',
        body: `Same spec: [the spec](${UPLOADS}/spec.pdf), and [run log](${UPLOADS}/run.log).`,
        createdAt: '2026-10-02T09:00:00.000Z',
      },
      { author: 'unknown', body: 'Imported from elsewhere.', createdAt: '2026-10-03T09:00:00.000Z' },
    ],
    links: [
      { url: 'https://linear.app/sail-test/issue/ADW-8', title: 'blocks ADW-8: Say goodbye' },
      { url: 'https://linear.app/sail-test/issue/ADW-3', title: 'related ADW-3: Greeting design' },
      { url: 'https://example.com/design', title: 'Design doc' },
    ],
    attachments: [
      { name: 'Design doc', url: 'https://example.com/design' },
      { name: 'mock.png', url: `${UPLOADS}/mock.png` },
      { name: 'the spec', url: `${UPLOADS}/spec.pdf` },
      { name: 'run log', url: `${UPLOADS}/run.log` },
    ],
    raw: NODE,
  });
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('the seven Linear state types read as sail’s four, each keeping Linear’s name for the state', () => {
  const types = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate'];
  const states = types.map((type) => ticketOf(nodeWith({ state: { id: `s-${type}`, name: `N ${type}`, type } })).state);
  expect(states).toEqual([
    { type: 'unstarted', name: 'N triage' },
    { type: 'unstarted', name: 'N backlog' },
    { type: 'unstarted', name: 'N unstarted' },
    { type: 'started', name: 'N started' },
    { type: 'completed', name: 'N completed' },
    { type: 'canceled', name: 'N canceled' },
    { type: 'canceled', name: 'N duplicate' },
  ]);
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a state type sail does not know is invalid for the operation, naming the type', () => {
  const node = nodeWith({ state: { id: 's-paused', name: 'Paused', type: 'paused' } });
  const error = caught(() => toTicket(node, [], 'listDesignated'));
  expect(error instanceof PortError ? [error.op, error.code, error.message] : error).toEqual([
    'listDesignated',
    'invalid',
    "ticketSource.listDesignated: Linear's state type 'paused' is not one sail knows",
  ]);
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a null description reads as empty', () => {
  const { ticketKey, description } = ticketOf(nodeWith({ description: null }));
  expect({ ticketKey, description }).toEqual({ ticketKey: 'ADW-7', description: '' });
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a node without a state, or with a null list, is invalid, naming the field: nothing is made up', () => {
  const { state: _, ...stateless } = structuredClone(NODE);
  const errors = [stateless, nodeWith({ labels: null }), nodeWith({ attachments: null })].map((node) =>
    caught(() => toTicket(node, [], 'get')),
  );
  expect(errors.map((error) => (error instanceof PortError ? [error.code, error.message] : error))).toEqual([
    ['invalid', 'ticketSource.get: Linear sent a ticket whose state is missing or malformed'],
    ['invalid', 'ticketSource.get: Linear sent a ticket whose labels is missing or malformed'],
    ['invalid', 'ticketSource.get: Linear sent a ticket whose attachments is missing or malformed'],
  ]);
});
