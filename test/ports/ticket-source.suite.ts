// The TicketSource port suite: what every TicketSource adapter must do. The fake runs it in
// test/adapters/fake/ticket-source.test.ts, and a real adapter's test runs it against its provider on demand
// (SAIL_LIVE_TICKET_SOURCE=1). Each case starts from a fresh make(), and every event it captures must validate against
// sail.event.v1, both as a call emits it, with a key, and as dispatch does, without one.
import { expect, test } from 'bun:test';
import type { ProviderEmit, ProviderEvent } from '../../src/events/types';
import type { TicketSource } from '../../src/ports/ticket-source';
import { ClaimResult, Moved, Posted, Ticket, TicketSourceCapabilities } from '../../src/ports/types';
import {
  type Captured,
  captureEvents,
  eventIssues,
  parseIssues,
  portFailure,
  rejection,
  timed,
} from '../helpers/ports';

/** The tickets a suite run needs, by ticket key, in the provider behind the adapter. */
export interface TicketWorld {
  /** The designation label. */
  readonly label: string;
  /** Designated and unstarted. */
  readonly designated: string;
  /** Designated, and already started. */
  readonly started: string;
  /** Unstarted, without the label. */
  readonly undesignated: string;
  /** No such ticket. */
  readonly missing: string;
  /** Refs the adapter accepts, each with the ticket key it names. */
  readonly refs: readonly (readonly [string, string])[];
}

export type MakeTicketSource = (emit: ProviderEmit) => Promise<{ adapter: TicketSource; world: TicketWorld }>;

const keys = (tickets: readonly Ticket[]): string[] => tickets.map((ticket) => ticket.ticketKey);

/** Every captured event validates against sail.event.v1, stamped with a call's key and without one. */
function expectValidEvents(capture: Pick<Captured<ProviderEvent>, 'stamped'>): void {
  expect(eventIssues(capture.stamped('publish#1/open'))).toEqual([]);
  expect(eventIssues(capture.stamped())).toEqual([]);
}

export function ticketSourceSuite(label: string, make: MakeTicketSource): void {
  const start = async () => {
    const capture = captureEvents();
    return { capture, ...(await make(capture.emit)) };
  };

  test(`${label}: parseKey gives the ticket key each ref names, and nothing for anything else`, async () => {
    const { adapter, world } = await start();
    expect(world.refs.map(([ref]) => adapter.parseKey(ref))).toEqual(world.refs.map(([, ticketKey]) => ticketKey));
    expect(adapter.parseKey('not a key')).toBeUndefined();
  });

  test(`${label}: get gives the ticket with raw, and emits one ticket:fetched that counts what it holds`, async () => {
    const { adapter, world, capture } = await start();
    const ticket = await adapter.get(world.designated);
    expect(parseIssues(Ticket, ticket)).toEqual([]);
    expect(ticket.ticketKey).toBe(world.designated);
    expect(timed(capture.events)).toEqual([
      {
        type: 'ticket:fetched',
        ticketKey: world.designated,
        comments: ticket.comments.length,
        links: ticket.links.length,
        attachments: ticket.attachments.length,
        durationMs: 'ms',
      },
    ]);
    expectValidEvents(capture);
  });

  test(`${label}: every operation on an unknown ticket key rejects with not_found, naming the operation`, async () => {
    const { adapter, world, capture } = await start();
    const failures = [
      portFailure(await rejection(adapter.get(world.missing))),
      portFailure(await rejection(adapter.claim(world.missing))),
      portFailure(await rejection(adapter.update(world.missing, { state: 'done' }))),
      portFailure(await rejection(adapter.comment(world.missing, 'hello'))),
    ];
    expect(failures).toEqual(
      ['get', 'claim', 'update', 'comment'].map((op) => ({ port: 'ticketSource', op, code: 'not_found' })),
    );
    expect(capture.events).toEqual([]);
  });

  test(`${label}: isDesignated holds for a ticket carrying the label, and only that label`, async () => {
    const { adapter, world } = await start();
    const designated = await adapter.get(world.designated);
    const undesignated = await adapter.get(world.undesignated);
    expect([
      adapter.isDesignated(designated, world.label),
      adapter.isDesignated(undesignated, world.label),
      adapter.isDesignated(designated, 'not-the-label'),
    ]).toEqual([true, false, false]);
  });

  test(`${label}: listDesignated holds the designated ticket, but not a started or an undesignated one`, async () => {
    const { adapter, world } = await start();
    const listed = await adapter.listDesignated(world.label);
    expect(listed.flatMap((ticket) => parseIssues(Ticket, ticket))).toEqual([]);
    expect(keys(listed)).toContain(world.designated);
    expect(keys(listed).filter((key) => key === world.started || key === world.undesignated)).toEqual([]);
  });

  test(`${label}: a claim starts the ticket and takes it off listDesignated, and a second claim is not taken`, async () => {
    const { adapter, world, capture } = await start();
    const first = await adapter.claim(world.designated);
    expect(parseIssues(ClaimResult, first)).toEqual([]);
    expect([first.claimed, first.state.type]).toEqual([true, 'started']);
    expect(keys(await adapter.listDesignated(world.label))).not.toContain(world.designated);

    const second = await adapter.claim(world.designated);
    expect({ claimed: second.claimed, state: second.state }).toEqual({ claimed: false, state: first.state });
    expect(capture.events).toEqual([{ type: 'ticket:claimed', ticketKey: world.designated, state: first.state }]);
    expectValidEvents(capture);
  });

  test(`${label}: a claim on a started ticket is not taken, and emits nothing`, async () => {
    const { adapter, world, capture } = await start();
    const result = await adapter.claim(world.started);
    expect(parseIssues(ClaimResult, result)).toEqual([]);
    expect({ claimed: result.claimed, type: result.state.type, events: capture.events }).toEqual({
      claimed: false,
      type: 'started',
      events: [],
    });
  });

  test(`${label}: update moves the ticket to the state the provider reports, and emits ticket:updated`, async () => {
    const { adapter, world, capture } = await start();
    const moved = await adapter.update(world.designated, { state: 'in-review' });
    expect(parseIssues(Moved, moved)).toEqual([]);
    expect(moved.state.type).toBe('started');
    expect((await adapter.get(world.designated)).state).toEqual(moved.state);
    expect(capture.events.map((event) => event.type)).toEqual(['ticket:updated', 'ticket:fetched']);
    expect(capture.events[0]).toEqual({
      type: 'ticket:updated',
      ticketKey: world.designated,
      change: { state: 'in-review' },
      state: moved.state,
    });
    expectValidEvents(capture);
  });

  test(`${label}: a comment is posted onto the ticket, and emits ticket:commented`, async () => {
    const { adapter, world, capture } = await start();
    const posted = await adapter.comment(world.designated, 'Pull request opened.');
    expect(parseIssues(Posted, posted)).toEqual([]);
    expect((await adapter.get(world.designated)).comments.at(-1)?.body).toBe('Pull request opened.');
    expect(capture.events[0]).toEqual({
      type: 'ticket:commented',
      ticketKey: world.designated,
      body: 'Pull request opened.',
    });
    expectValidEvents(capture);
  });

  test(`${label}: capabilities parse, and update takes every move they list`, async () => {
    const { adapter, world } = await start();
    const capabilities = adapter.capabilities();
    expect(parseIssues(TicketSourceCapabilities, capabilities)).toEqual([]);
    expect(capabilities.moves).not.toEqual([]);
    const issues: unknown[] = [];
    for (const move of capabilities.moves) {
      issues.push(parseIssues(Moved, await adapter.update(world.designated, { state: move })));
    }
    expect(issues).toEqual(capabilities.moves.map(() => []));
  });
}
