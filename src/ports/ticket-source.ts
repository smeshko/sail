// The TicketSource port: the ticket system in sail's words, whatever the provider. A ticket's state is reported by type,
// and moved by the four moves ADR-0015 names. The claim is the only move that can not happen, and says so as a value.
import type { ProviderEmit } from '../events/types';
import type { ClaimResult, Moved, Posted, Ticket, TicketMove, TicketSourceCapabilities } from './types';

/** What every adapter factory takes beside its own options. */
export interface ProviderOptions {
  /** Where the adapter emits its provider events. The caller stamps each one. */
  readonly emit?: ProviderEmit;
  /** The clock behind durations and timestamps. */
  readonly now?: () => Date;
}

export interface TicketSource {
  readonly name: string;
  /** The ticket key `ref` names: a ticket key, or a URL the provider owns. Undefined for anything else. */
  parseKey(ref: string): string | undefined;
  /** The ticket with its comments, links and attachments. Emits `ticket:fetched`. */
  get(ticketKey: string): Promise<Ticket>;
  isDesignated(ticket: Ticket, label: string): boolean;
  /** The designated tickets that are still unstarted. */
  listDesignated(label: string): Promise<Ticket[]>;
  /** Moves an unstarted ticket to in progress. Emits `ticket:claimed` only when the claim took (D4). */
  claim(ticketKey: string): Promise<ClaimResult>;
  /** Moves the ticket, and returns the state the provider reports. Emits `ticket:updated`. */
  update(ticketKey: string, change: { readonly state: TicketMove }): Promise<Moved>;
  /** Emits `ticket:commented`. */
  comment(ticketKey: string, body: string): Promise<Posted>;
  capabilities(): TicketSourceCapabilities;
}
