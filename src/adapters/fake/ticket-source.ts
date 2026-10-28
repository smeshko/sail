// The fake TicketSource: tickets in a committed seed file, with every change kept in a separate state file that later
// instances read, so a claim made in one process is seen in the next (D1).
import { z } from 'zod';
import type { ProviderEvent } from '../../events/types';
import { PortError } from '../../ports/errors';
import { checkAttachment, type ProviderOptions, type TicketSource } from '../../ports/ticket-source';
import {
  Attachment,
  Comment,
  Link,
  type ListedTicket,
  type Ticket,
  TicketMove,
  TicketState,
  TicketStateType,
} from '../../ports/types';
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

/** `labels` names the team's labels; a seed without it knows every label. */
const World = z.object({ labels: z.array(z.string()).optional(), tickets: z.array(StoredTicket) });
type World = z.infer<typeof World>;

/** The team's spelling of `name`, matched without regard to case. An unknown label is `invalid`. */
function knownLabel(world: World, op: string, name: string): string {
  if (world.labels === undefined) return name;
  const found = world.labels.find((each) => each.toLowerCase() === name.toLowerCase());
  if (found === undefined) throw new PortError('ticketSource', op, 'invalid', `no label ${name}`);
  return found;
}

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

const toListed = (stored: StoredTicket): ListedTicket => {
  const { ticketKey, title, description, state, labels } = structuredClone(stored);
  return {
    ticketKey,
    title,
    description,
    state,
    labels,
    url: `fake://tickets/${ticketKey}`,
    raw: structuredClone(stored),
  };
};

export function createFakeTicketSource(options: FakeTicketSourceOptions): TicketSource {
  const store = createStore({ seed: options.seed, state: options.state, schema: World, port: 'ticketSource' });
  const now = () => options.now?.() ?? new Date();
  const emit = (event: ProviderEvent) => options.emit?.(event);
  const find = (world: World, op: string, ticketKey: string): StoredTicket => {
    const found = world.tickets.find((ticket) => ticket.ticketKey === ticketKey);
    if (found === undefined) throw new PortError('ticketSource', op, 'not_found', `no ticket ${ticketKey}`);
    return found;
  };

  const relabel = async (op: 'addLabel' | 'removeLabel', ticketKey: string, label: string) => {
    const adding = op === 'addLabel';
    const changed = store.change((world) => {
      const ticket = find(world, op, ticketKey);
      const name = knownLabel(world, op, label);
      const carried = ticket.labels.includes(name);
      if (carried === adding)
        return { name, changed: false, ticketKey, labels: [...ticket.labels], raw: structuredClone(ticket) };
      ticket.labels = adding ? [...ticket.labels, name] : ticket.labels.filter((each) => each !== name);
      return { name, changed: true, ticketKey, labels: [...ticket.labels], raw: structuredClone(ticket) };
    });
    const { name, changed: did, ...relabelled } = changed;
    if (did)
      emit({
        type: adding ? 'ticket:labelled' : 'ticket:unlabelled',
        ticketKey,
        label: name,
        labels: relabelled.labels,
      });
    return relabelled;
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
        title: ticket.title,
        url: ticket.url,
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
    async list(filter) {
      if (filter.state !== undefined && !TicketStateType.safeParse(filter.state).success) {
        throw new PortError('ticketSource', 'list', 'invalid', `${String(filter.state)} is not a ticket state`);
      }
      return store
        .read()
        .tickets.filter(
          (ticket) =>
            (filter.state === undefined || ticket.state.type === filter.state) &&
            (filter.label === undefined || ticket.labels.includes(filter.label)),
        )
        .sort((a, b) => ticketNumber(a.ticketKey) - ticketNumber(b.ticketKey))
        .map(toListed);
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
      // A move from outside TypeScript, such as `sail port`, is checked before it reaches the state file.
      if (!TicketMove.safeParse(change.state).success) {
        throw new PortError('ticketSource', 'update', 'invalid', `${String(change.state)} is not a move`);
      }
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
    async create({ title, description, labels }) {
      const created = store.change((world) => {
        const highest = Math.max(0, ...world.tickets.map((ticket) => ticketNumber(ticket.ticketKey)));
        const ticket: StoredTicket = {
          ticketKey: `FAKE-${highest + 1}`,
          title,
          description,
          state: { ...STATES.unstarted },
          labels: [...labels],
          comments: [],
          links: [],
          attachments: [],
        };
        world.tickets.push(ticket);
        return { ticketKey: ticket.ticketKey, url: `fake://tickets/${ticket.ticketKey}`, raw: structuredClone(ticket) };
      });
      emit({ type: 'ticket:created', ticketKey: created.ticketKey, title, url: created.url });
      return created;
    },
    addLabel: (ticketKey, label) => relabel('addLabel', ticketKey, label),
    removeLabel: (ticketKey, label) => relabel('removeLabel', ticketKey, label),
    async attach(ticketKey, file) {
      checkAttachment(file);
      const name = file.title ?? file.name;
      const attached = store.change((world) => {
        const ticket = find(world, 'attach', ticketKey);
        const url = `fake://tickets/${ticketKey}/attachments/${ticket.attachments.length + 1}`;
        const attachment = { name, url, mimeType: file.contentType };
        ticket.attachments.push(attachment);
        return { url, raw: structuredClone(attachment) };
      });
      const { contentType, bytes } = file;
      emit({ type: 'ticket:attached', ticketKey, name, contentType, size: bytes.byteLength, url: attached.url });
      return attached;
    },
    capabilities: () => ({
      comments: true,
      links: true,
      attachments: true,
      moves: ['unstarted', 'in-progress', 'in-review', 'done'],
    }),
  };
}
