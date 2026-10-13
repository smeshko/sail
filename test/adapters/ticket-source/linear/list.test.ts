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

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('listDesignated lists the designated tickets in backlog or unstarted, and no others, each as a parsed Ticket', async () => {
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

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('listDesignated pages through every page, and returns every match', async () => {
    const world = createLinearWorld({
      pageSize: 2,
      issues: ['ADW-1', 'ADW-2', 'ADW-3', 'ADW-4', 'ADW-5'].map((key) => issue(key, 'Todo')),
    });
    const adapter = createLinearTicketSource({ apiKey: KEY, team: 'ADW', fetch: world.transport });
    const listed = await adapter.listDesignated('sail');
    expect(keysOf(listed)).toEqual(['ADW-1', 'ADW-2', 'ADW-3', 'ADW-4', 'ADW-5']);
    expect(world.requests.filter((sent) => sent.operation === 'ListIssues').length).toBeGreaterThan(1);
  });

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('listDesignated classifies by state type, so a team with renamed states lists the same tickets', async () => {
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

// biome-ignore format: TDD-PENDING TASK-004
test
  .skip // TDD-PENDING TASK-004
  ('capabilities parse, and list in-review only when inReviewState names a state', () => {
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
