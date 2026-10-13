// The Linear TicketSource: the adapter over Linear's GraphQL API, and its adapter definition, which the built-in
// registration hands the registry (DECISIONS §1 to §6).
// Stub: the operations are written in TASK-003 to TASK-005, the definition in TASK-006.
import type { AdapterDefinition } from '../../../ports/adapter';
import type { ProviderOptions, TicketSource } from '../../../ports/ticket-source';

export interface LinearTicketSourceOptions extends ProviderOptions {
  /** The key from `LINEAR_API_KEY`. It is sent as the Authorization header and nowhere else. */
  readonly apiKey: string;
  /** The team key, such as `ADW`. Ticket keys of any other team are not this adapter's. */
  readonly team: string;
  /** The name of the started state that means in review. Without it, `in-review` is not a move. */
  readonly inReviewState?: string;
  /** The transport. Left out, the client reads `globalThis.fetch` at each call. */
  readonly fetch?: typeof fetch;
}

export function createLinearTicketSource(_options: LinearTicketSourceOptions): TicketSource {
  return {
    name: 'linear',
    parseKey: () => undefined,
    get: async () => ({
      ticketKey: '',
      title: '',
      url: '',
      description: '',
      state: { type: 'unstarted', name: '' },
      labels: [],
      comments: [],
      links: [],
      attachments: [],
      raw: null,
    }),
    isDesignated: () => false,
    listDesignated: async () => [],
    claim: async () => ({ claimed: false, state: { type: 'unstarted', name: '' }, raw: null }),
    update: async () => ({ state: { type: 'unstarted', name: '' }, raw: null }),
    comment: async () => ({ id: '', raw: null }),
    capabilities: () => ({ comments: false, links: false, attachments: false, moves: [] }),
  };
}

/** The built-in `linear` ticket source: its options, its credential and its creation. */
export const linearAdapters: { ticketSource: AdapterDefinition<TicketSource> } = {
  ticketSource: {
    create: () => createLinearTicketSource({ apiKey: '', team: '' }),
  },
};
