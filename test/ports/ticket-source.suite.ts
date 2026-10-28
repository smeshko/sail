// The TicketSource port suite: what every TicketSource adapter must do. The fake runs it in
// test/adapters/fake/ticket-source.test.ts, and a real adapter's test runs it against its provider on demand
// (SAIL_LIVE_TICKET_SOURCE=1). Each case starts from a fresh make(), and every event it captures must validate against
// sail.event.v1, both as a call emits it, with a key, and as dispatch does, without one.
import { expect, test } from 'bun:test';
import type { ProviderEmit, ProviderEvent } from '../../src/events/types';
import { MAX_ATTACHMENT_BYTES, type TicketSource } from '../../src/ports/ticket-source';
import {
  Attached,
  ClaimResult,
  ListedTicket,
  Moved,
  Posted,
  Relabelled,
  Related,
  Ticket,
  type TicketMove,
  TicketSourceCapabilities,
  type TicketStateType,
} from '../../src/ports/types';
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
  /** A label the team has and `designated` lacks. */
  readonly spareLabel: string;
  /** A label the team lacks. */
  readonly unknownLabel: string;
  /** Refs the adapter accepts, each with the ticket key it names. */
  readonly refs: readonly (readonly [string, string])[];
}

export type MakeTicketSource = (emit: ProviderEmit) => Promise<{ adapter: TicketSource; world: TicketWorld }>;

/** A small text file, as the demonstrate stage's transcript is. */
const TRANSCRIPT = {
  name: 'transcript.txt',
  contentType: 'text/plain',
  bytes: new TextEncoder().encode('$ sail show FAKE-1\ntotal $1.35\nexit 0\n'),
};

const keys = (tickets: readonly Ticket[]): string[] => tickets.map((ticket) => ticket.ticketKey);

/** The state type each move lands on, whatever the provider names the state (D8). */
const MOVE_TYPES: Record<TicketMove, TicketStateType> = {
  unstarted: 'unstarted',
  'in-progress': 'started',
  'in-review': 'started',
  done: 'completed',
};

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

  test(`${label}: get gives the ticket with raw, and emits one ticket:fetched that names it by its title and URL and counts what it holds`, async () => {
    const { adapter, world, capture } = await start();
    const ticket = await adapter.get(world.designated);
    expect(parseIssues(Ticket, ticket)).toEqual([]);
    expect(ticket.ticketKey).toBe(world.designated);
    expect(timed(capture.events)).toEqual([
      {
        type: 'ticket:fetched',
        ticketKey: world.designated,
        title: ticket.title,
        url: ticket.url,
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
    const links = (await adapter.get(world.designated)).links;
    capture.events.length = 0;
    const failures = [
      portFailure(await rejection(adapter.get(world.missing))),
      portFailure(await rejection(adapter.claim(world.missing))),
      portFailure(await rejection(adapter.update(world.missing, { state: 'done' }))),
      portFailure(await rejection(adapter.comment(world.missing, 'hello'))),
      portFailure(await rejection(adapter.attach(world.missing, TRANSCRIPT))),
      portFailure(await rejection(adapter.addLabel(world.missing, world.spareLabel))),
      portFailure(await rejection(adapter.removeLabel(world.missing, world.label))),
      portFailure(await rejection(adapter.relate(world.missing, { kind: 'related', to: world.designated }))),
      portFailure(await rejection(adapter.relate(world.designated, { kind: 'related', to: world.missing }))),
    ];
    expect(failures).toEqual(
      ['get', 'claim', 'update', 'comment', 'attach', 'addLabel', 'removeLabel', 'relate', 'relate'].map((op) => ({
        port: 'ticketSource',
        op,
        code: 'not_found',
      })),
    );
    expect(capture.events).toEqual([]);
    expect((await adapter.get(world.designated)).links).toEqual(links);
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

  test(`${label}: list by state holds the unstarted tickets, but not a started one, each a ListedTicket, and emits nothing`, async () => {
    const { adapter, world, capture } = await start();
    const listed = await adapter.list({ state: 'unstarted' });
    expect(listed.flatMap((ticket) => parseIssues(ListedTicket, ticket))).toEqual([]);
    const found = listed.map((ticket) => ticket.ticketKey);
    expect(found).toContain(world.designated);
    expect(found).toContain(world.undesignated);
    expect(found).not.toContain(world.started);
    expect(listed.map((ticket) => ticket.state.type)).toEqual(listed.map(() => 'unstarted'));
    const read = await adapter.get(world.designated);
    const entry = listed.find((ticket) => ticket.ticketKey === world.designated);
    expect(entry).toMatchObject({
      title: read.title,
      url: read.url,
      description: read.description,
      labels: read.labels,
    });
    expect(capture.events.map((event) => event.type)).toEqual(['ticket:fetched']);
  });

  test(`${label}: list by state and label holds the designated ticket, but not the undesignated one`, async () => {
    const { adapter, world } = await start();
    const listed = await adapter.list({ state: 'unstarted', label: world.label });
    const found = listed.map((ticket) => ticket.ticketKey);
    expect(found).toContain(world.designated);
    expect(found).not.toContain(world.undesignated);
    expect(listed.every((ticket) => ticket.labels.includes(world.label))).toBe(true);
  });

  test(`${label}: list with a state that isn't one rejects as invalid, naming list, and emits nothing`, async () => {
    const { adapter, capture } = await start();
    const error = await rejection(adapter.list({ state: 'open' as never }));
    expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'list', code: 'invalid' });
    expect(capture.events).toEqual([]);
  });

  test(`${label}: addLabel then removeLabel leaves the ticket's labels as they were, each returning the labels after it and emitting ticket:labelled then ticket:unlabelled`, async () => {
    const { adapter, world, capture } = await start();
    const before = (await adapter.get(world.designated)).labels;
    const added = await adapter.addLabel(world.designated, world.spareLabel);
    expect(parseIssues(Relabelled, added)).toEqual([]);
    expect(added.ticketKey).toBe(world.designated);
    expect([...added.labels].sort()).toEqual([...before, world.spareLabel].sort());
    expect([...(await adapter.get(world.designated)).labels].sort()).toEqual([...added.labels].sort());

    const removed = await adapter.removeLabel(world.designated, world.spareLabel);
    expect(parseIssues(Relabelled, removed)).toEqual([]);
    expect([...removed.labels].sort()).toEqual([...before].sort());
    expect([...(await adapter.get(world.designated)).labels].sort()).toEqual([...before].sort());

    const changes = capture.events.filter((event) => event.type !== 'ticket:fetched');
    expect(changes).toEqual([
      { type: 'ticket:labelled', ticketKey: world.designated, label: world.spareLabel, labels: added.labels },
      { type: 'ticket:unlabelled', ticketKey: world.designated, label: world.spareLabel, labels: removed.labels },
    ]);
    expectValidEvents(capture);
  });

  test(`${label}: addLabel of a label the ticket carries and removeLabel of one it lacks return its labels as they are, and emit nothing`, async () => {
    const { adapter, world, capture } = await start();
    const before = (await adapter.get(world.designated)).labels;
    const added = await adapter.addLabel(world.designated, world.label);
    const removed = await adapter.removeLabel(world.designated, world.spareLabel);
    expect([[...added.labels].sort(), [...removed.labels].sort()]).toEqual([[...before].sort(), [...before].sort()]);
    expect(capture.events.map((event) => event.type)).toEqual(['ticket:fetched']);
  });

  test(`${label}: addLabel and removeLabel of a label the team lacks reject as invalid, naming the operation, and change and emit nothing`, async () => {
    const { adapter, world, capture } = await start();
    const before = (await adapter.get(world.designated)).labels;
    const failures = [
      portFailure(await rejection(adapter.addLabel(world.designated, world.unknownLabel))),
      portFailure(await rejection(adapter.removeLabel(world.designated, world.unknownLabel))),
    ];
    expect(failures).toEqual([
      { port: 'ticketSource', op: 'addLabel', code: 'invalid' },
      { port: 'ticketSource', op: 'removeLabel', code: 'invalid' },
    ]);
    expect((await adapter.get(world.designated)).labels).toEqual(before);
    expect(capture.events.map((event) => event.type)).toEqual(['ticket:fetched', 'ticket:fetched']);
  });

  test(`${label}: relate with duplicate closes the ticket in a canceled state and links it to the other, and emits one ticket:related`, async () => {
    const { adapter, world, capture } = await start();
    const other = await adapter.get(world.designated);
    const related = await adapter.relate(world.undesignated, { kind: 'duplicate', to: world.designated });
    expect(parseIssues(Related, related)).toEqual([]);
    expect([related.ticketKey, related.kind, related.to, related.state.type]).toEqual([
      world.undesignated,
      'duplicate',
      world.designated,
      'canceled',
    ]);
    const read = await adapter.get(world.undesignated);
    expect(read.state).toEqual(related.state);
    expect(read.links.map((link) => link.url)).toContain(other.url);
    expect(capture.events.filter((event) => event.type !== 'ticket:fetched')).toEqual([
      {
        type: 'ticket:related',
        ticketKey: world.undesignated,
        kind: 'duplicate',
        to: world.designated,
        state: related.state,
      },
    ]);
    expectValidEvents(capture);
  });

  test(`${label}: relate with related or blocks leaves the ticket's state alone`, async () => {
    const { adapter, world } = await start();
    const before = (await adapter.get(world.undesignated)).state;
    const related = await adapter.relate(world.undesignated, { kind: 'related', to: world.designated });
    const blocks = await adapter.relate(world.undesignated, { kind: 'blocks', to: world.started });
    expect([related.state, blocks.state, (await adapter.get(world.undesignated)).state]).toEqual([
      before,
      before,
      before,
    ]);
  });

  test(`${label}: relate of a ticket to itself, or with a kind that isn't one, rejects as invalid, naming relate, and changes and emits nothing`, async () => {
    const { adapter, world, capture } = await start();
    const failures = [
      portFailure(await rejection(adapter.relate(world.designated, { kind: 'related', to: world.designated }))),
      portFailure(await rejection(adapter.relate(world.designated, { kind: 'twin' as never, to: world.undesignated }))),
    ];
    expect(failures).toEqual([
      { port: 'ticketSource', op: 'relate', code: 'invalid' },
      { port: 'ticketSource', op: 'relate', code: 'invalid' },
    ]);
    expect(capture.events).toEqual([]);
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

  test(`${label}: update with a move that isn't one rejects as invalid, and leaves the ticket and later reads alone`, async () => {
    const { adapter, world, capture } = await start();
    const before = (await adapter.get(world.designated)).state;
    const error = await rejection(adapter.update(world.designated, { state: 'closed' as TicketMove }));
    expect(portFailure(error)).toEqual({ port: 'ticketSource', op: 'update', code: 'invalid' });
    expect((await adapter.get(world.started)).ticketKey).toBe(world.started);
    expect((await adapter.get(world.designated)).state).toEqual(before);
    expect(capture.events.map((event) => event.type)).toEqual(['ticket:fetched', 'ticket:fetched', 'ticket:fetched']);
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

  test(`${label}: attach puts the file on the ticket under its title, where get lists it, and emits ticket:attached`, async () => {
    const { adapter, world, capture } = await start();
    const attached = await adapter.attach(world.designated, { ...TRANSCRIPT, title: 'Demonstration transcript' });
    expect(parseIssues(Attached, attached)).toEqual([]);
    const listed = (await adapter.get(world.designated)).attachments.find((each) => each.url === attached.url);
    expect(listed?.name).toBe('Demonstration transcript');
    expect(capture.events[0]).toEqual({
      type: 'ticket:attached',
      ticketKey: world.designated,
      name: 'Demonstration transcript',
      contentType: 'text/plain',
      size: TRANSCRIPT.bytes.byteLength,
      url: attached.url,
    });
    expectValidEvents(capture);
  });

  test(`${label}: attach refuses a file it can't send as invalid before reaching the ticket, and emits nothing`, async () => {
    const { adapter, world, capture } = await start();
    const files = [
      { ...TRANSCRIPT, name: ' ' },
      { ...TRANSCRIPT, contentType: 'text' },
      { ...TRANSCRIPT, bytes: new Uint8Array() },
      { ...TRANSCRIPT, bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) },
    ];
    const failures = [];
    for (const file of files) failures.push(portFailure(await rejection(adapter.attach(world.missing, file))));
    expect(failures).toEqual(files.map(() => ({ port: 'ticketSource', op: 'attach', code: 'invalid' })));
    expect(capture.events).toEqual([]);
  });

  test(`${label}: capabilities parse, and update takes every move they list to a state of that move's type`, async () => {
    const { adapter, world } = await start();
    const capabilities = adapter.capabilities();
    expect(parseIssues(TicketSourceCapabilities, capabilities)).toEqual([]);
    expect(capabilities.moves).not.toEqual([]);
    const moved: unknown[] = [];
    for (const move of capabilities.moves) {
      const result = await adapter.update(world.designated, { state: move });
      const read = await adapter.get(world.designated);
      moved.push({ move, issues: parseIssues(Moved, result), type: result.state.type, read: read.state.type });
    }
    expect(moved).toEqual(
      capabilities.moves.map((move) => ({ move, issues: [], type: MOVE_TYPES[move], read: MOVE_TYPES[move] })),
    );
  });
}
