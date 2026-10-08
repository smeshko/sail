// A run's source, checked and then claimed, on the TicketSource port alone. Stubs: the signatures are final, and each
// body answers with nothing.
import type { ProviderEvent } from '../events/types';
import type { TicketSource } from '../ports/ticket-source';
import type { Ticket } from '../ports/types';
import type { Forced } from './run-dir';
import type { ClaimRecord } from './run-header';

/** Why `ref` names no ticket of the ticket source `adapterName`. Stub: says nothing. */
export function notATicket(_ref: string, _adapterName: string): string {
  return '';
}

export interface ResolveSourceOptions {
  /** What the run was started with, as typed: a ticket key, or a URL the ticket source owns. */
  ref: string;
  ticketSource: TicketSource;
  /** The designation label: the repository's, or sail's own. */
  label: string;
  /** Skips the label and state checks. */
  force?: boolean;
}

export interface ResolvedSource {
  ticketKey: string;
  ticket: Ticket;
  /** `designation` when `--force` overrode a missing label. */
  forced: Forced[];
}

/** The ticket `ref` names, fetched and checked. Stub: refuses everything, with nothing to say. */
export async function resolveSource(_options: ResolveSourceOptions): Promise<ResolvedSource | { refused: string }> {
  return { refused: '' };
}

/** The comment a run leaves on its ticket as it starts. Stub: empty. */
export function claimComment(_runId: string): string {
  return '';
}

export interface ClaimSourceOptions {
  ticketKey: string;
  /** The run the comment names. */
  runId: string;
  ticketSource: TicketSource;
  /** Moves a ticket whose claim didn't take, where a run nobody forced is refused. */
  force?: boolean;
}

export interface ClaimedSource {
  claim: ClaimRecord;
  /** `state` when `--force` overrode a claim that didn't take. */
  forced: Forced[];
  /** What was done to the ticket, in order, for the run's stream. */
  events: ProviderEvent[];
}

/** Claims the ticket, or moves a forced one, then comments with the run id. Stub: refuses, with nothing to say. */
export async function claimSource(_options: ClaimSourceOptions): Promise<ClaimedSource | { refused: string }> {
  return { refused: '' };
}
