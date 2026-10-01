// The fake TicketSource: tickets in a committed seed file, with every change kept in a separate state file that later
// instances read, so a claim made in one process is seen in the next (D1).
import { z } from 'zod';
import type { ProviderEvent } from '../../events/types';
import { PortError } from '../../ports/errors';
import type { ProviderOptions, TicketSource } from '../../ports/ticket-source';
import { Attachment, Comment, Link, type Ticket, type TicketMove, TicketState } from '../../ports/types';
import { createStore } from './store';

export interface FakeTicketSourceOptions extends ProviderOptions {
  /** The committed world. Never written. */
  readonly seed: string;
  /** Where the world's changes are kept. Read instead of `seed` once it exists. */
  readonly state: string;
}

/** A ticket as the seed holds it: its URL and `raw` are derived. */
const StoredTicket = z.object({
  ticketKey: z.string(),
  title: z.string(),
  description: z.string(),
  state: TicketState,
  labels: z.array(z.string()),
  comments: z.array(Comment),
  links: z.array(Link),
  attachments: z.array(Attachment),
});
type StoredTicket = z.infer<typeof StoredTicket>;

const World = z.object({ tickets: z.array(StoredTicket) });
type World = z.infer<typeof World>;

/** The fake's state for each move, named as a Linear-like provider names them. */
const STATES: Record<TicketMove, TicketState> = {
  unstarted: { type: 'unstarted', name: 'Todo' },
  'in-progress': { type: 'started', name: 'In Progress' },
  'in-review': { type: 'started', name: 'In Review' },
  done: { type: 'completed', name: 'Done' },
};

const KEY = /^FAKE-\d+$/;
const URL_KEY = /^fake:\/\/tickets\/(FAKE-\d+)$/;

const ticketNumber = (ticketKey: string): number => Number(ticketKey.slice('FAKE-'.length));

/** A copy of the stored ticket, so changing what a caller is given never reaches the store. */
const toTicket = (stored: StoredTicket): Ticket => ({
  ...structuredClone(stored),
  url: `fake://tickets/${stored.ticketKey}`,
  raw: structuredClone(stored),
});

export function createFakeTicketSource(options: FakeTicketSourceOptions): TicketSource {
  const store = createStore({ seed: options.seed, state: options.state, schema: World, port: 'ticketSource' });
  const now = () => options.now?.() ?? new Date();
  const emit = (event: ProviderEvent) => options.emit?.(event);
  const find = (world: World, op: string, ticketKey: string): StoredTicket => {
    const found = world.tickets.find((ticket) => ticket.ticketKey === ticketKey);
    if (found === undefined) throw new PortError('ticketSource', op, 'not_found', `no ticket ${ticketKey}`);
    return found;
  };

  return {
    name: 'fake',
    parseKey: (ref) => (KEY.test(ref) ? ref : URL_KEY.exec(ref)?.[1]),
    async get(ticketKey) {
      const started = now().getTime();
      const ticket = toTicket(find(store.read(), 'get', ticketKey));
      emit({
        type: 'ticket:fetched',
        ticketKey,
        comments: ticket.comments.length,
        links: ticket.links.length,
        attachments: ticket.attachments.length,
        durationMs: Math.max(0, now().getTime() - started),
      });
      return ticket;
    },
    isDesignated: (ticket, label) => ticket.labels.includes(label),
    async listDesignated(label) {
      return store
        .read()
        .tickets.filter((ticket) => ticket.labels.includes(label) && ticket.state.type === 'unstarted')
        .sort((a, b) => ticketNumber(a.ticketKey) - ticketNumber(b.ticketKey))
        .map(toTicket);
    },
    async claim(ticketKey) {
      const result = store.change((world) => {
        const ticket = find(world, 'claim', ticketKey);
        const claimed = ticket.state.type === 'unstarted';
        if (claimed) ticket.state = { ...STATES['in-progress'] };
        return { claimed, state: { ...ticket.state }, raw: structuredClone(ticket) };
      });
      if (result.claimed) emit({ type: 'ticket:claimed', ticketKey, state: result.state });
      return result;
    },
    async update(ticketKey, change) {
      const moved = store.change((world) => {
        const ticket = find(world, 'update', ticketKey);
        ticket.state = { ...STATES[change.state] };
        return { state: { ...ticket.state }, raw: structuredClone(ticket) };
      });
      emit({ type: 'ticket:updated', ticketKey, change: { state: change.state }, state: moved.state });
      return moved;
    },
    async comment(ticketKey, body) {
      const posted = store.change((world) => {
        const ticket = find(world, 'comment', ticketKey);
        ticket.comments.push({ author: 'sail', body, createdAt: now().toISOString() });
        const id = `comment-${ticket.comments.length}`;
        return { id, url: `fake://tickets/${ticketKey}#${id}`, raw: structuredClone(ticket) };
      });
      emit({ type: 'ticket:commented', ticketKey, body });
      return posted;
    },
    capabilities: () => ({
      comments: true,
      links: true,
      attachments: true,
      moves: ['unstarted', 'in-progress', 'in-review', 'done'],
    }),
  };
}
