// The fake TicketSource: tickets in a committed seed file, with every change kept in a separate state file that later
// instances read, so a claim made in one process is seen in the next (D1).
// STUB (TASK-004): every method answers as if the world were empty. TASK-004 writes it over store.ts.
import type { ProviderOptions, TicketSource } from '../../ports/ticket-source';
import type { TicketState } from '../../ports/types';

export interface FakeTicketSourceOptions extends ProviderOptions {
  /** The committed world. Never written. */
  readonly seed: string;
  /** Where the world's changes are kept. Read instead of `seed` once it exists. */
  readonly state: string;
}

const NOWHERE: TicketState = { type: 'unstarted', name: '' };

export function createFakeTicketSource(_options: FakeTicketSourceOptions): TicketSource {
  return {
    name: 'fake',
    parseKey: () => undefined,
    get: async (ticketKey) => ({
      ticketKey,
      title: '',
      url: '',
      description: '',
      state: NOWHERE,
      labels: [],
      comments: [],
      links: [],
      attachments: [],
      raw: null,
    }),
    isDesignated: () => false,
    listDesignated: async () => [],
    claim: async () => ({ claimed: false, state: NOWHERE, raw: null }),
    update: async () => ({ state: NOWHERE, raw: null }),
    comment: async () => ({ id: '', raw: null }),
    capabilities: () => ({ comments: false, links: false, attachments: false, moves: [] }),
  };
}
