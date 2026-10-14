// The Linear TicketSource: tickets of one Linear team, read with their comments, relations and attachments, claimed and
// moved by state type (DECISIONS D4), whatever the team calls its states. Every request goes through the GraphQL client,
// so each failure keeps Linear's message. The definition reads the API key, and the endpoint, from the operator's
// environment alone (D3).
//
// TDD stub (linear-ticket-source TASK-003 to TASK-005): the signatures are final, the bodies answer wrong. The stub is
// registered in BUILTINS already, so the built-in lists the existing tests name stay true from here on.
import type { AdapterDefinition } from '../../ports/adapter';
import type { ProviderOptions, TicketSource } from '../../ports/ticket-source';
import { type Fetch, LINEAR_ENDPOINT } from './linear-client';
import { toTicket } from './linear-ticket';

export interface LinearTicketSourceOptions extends ProviderOptions {
  /** The team key, such as `ADW`. */
  readonly team: string;
  /** The name of the team's `started` state that `in-review` moves to. Without it, `in-review` isn't a move. */
  readonly inReview?: string;
  readonly endpoint: string;
  readonly apiKey: string;
  readonly fetch?: Fetch;
}

const NOWHERE = { type: 'unstarted', name: '' } as const;

export function createLinearTicketSource(_options: LinearTicketSourceOptions): TicketSource {
  return {
    name: 'linear',
    parseKey: () => undefined,
    get: async (ticketKey) => ({ ...toTicket({}, [], 'get'), ticketKey }),
    isDesignated: () => false,
    listDesignated: async () => [],
    claim: async () => ({ claimed: false, state: { ...NOWHERE }, raw: null }),
    update: async () => ({ state: { ...NOWHERE }, raw: null }),
    comment: async () => ({ id: '', raw: null }),
    capabilities: () => ({ comments: false, links: false, attachments: false, moves: [] }),
  };
}

/** `linear` in `project.yaml`: `team` is required, `inReview` optional, and the key comes from `LINEAR_API_KEY`. */
export const linearTicketSource: AdapterDefinition<TicketSource> = {
  requires: () => [],
  create: () => createLinearTicketSource({ team: '', endpoint: LINEAR_ENDPOINT, apiKey: '' }),
};
