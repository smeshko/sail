// A run's source, checked and then claimed: the step between "which workflow" and the run directory, on the
// TicketSource port alone. `resolveSource()` turns the argument a run was started with into a ticket key and its
// ticket, or a refusal, and only reads. `claimSource()` then moves the ticket to In Progress, by the claim or by a
// forced move, and comments with the run id. That is all a start writes before its run directory exists, and a failure
// partway says where the ticket stands. A manual start calls both, and the watcher's dispatch will.
import type { ProviderEvent } from '../events/types';
import { PortError } from '../ports/errors';
import { getTicket, type TicketSource } from '../ports/ticket-source';
import type { Ticket, TicketState } from '../ports/types';
import type { Forced } from './run-dir';
import type { ClaimRecord } from './run-header';

/** Why `ref` names no ticket of the ticket source `adapterName`. */
export function notATicket(ref: string, adapterName: string): string {
  return `'${ref}' is not a ticket of the ${adapterName} ticket source: a ticket key, or a URL it owns`;
}

// Every refusal a ticket itself earns, in one place. Each says what `--force` would do about it.
const FORCE = '--force runs it anyway';
const notDesignated = (label: string) => `the ticket is not designated: it carries no '${label}' label. ${FORCE}`;
const notUnstarted = (state: TicketState) =>
  state.type === 'started'
    ? `the ticket is already claimed: it is ${state.name}. ${FORCE}`
    : `the ticket is not unstarted: it is ${state.name}. ${FORCE}`;

/** A port's failure as a refusal: its own message, with its code. Anything else is a bug in sail, and is thrown on. */
function refusalOf(error: unknown): string {
  if (!(error instanceof PortError)) throw error;
  return `${error.message} (${error.code})`;
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
  /** The ticket as fetched for the checks. The intake fetches it again, after the claim. */
  ticket: Ticket;
  /** `designation` when `--force` overrode a missing label. Whether the state was forced is the claim's to say. */
  forced: Forced[];
}

/**
 * The ticket `ref` names, fetched and checked: it carries `label`, and it is unstarted, each unless `force`. A ticket
 * that fails both checks is refused for the first. Nothing is written to the ticket.
 */
export async function resolveSource(options: ResolveSourceOptions): Promise<ResolvedSource | { refused: string }> {
  const { ref, ticketSource, label, force = false } = options;
  const ticketKey = ticketSource.parseKey(ref);
  if (ticketKey === undefined) return { refused: notATicket(ref, ticketSource.name) };
  let ticket: Ticket;
  try {
    ticket = await getTicket(ticketSource, ticketKey);
  } catch (error) {
    return { refused: refusalOf(error) };
  }
  const designated = ticketSource.isDesignated(ticket, label);
  if (!force) {
    if (!designated) return { refused: notDesignated(label) };
    if (ticket.state.type !== 'unstarted') return { refused: notUnstarted(ticket.state) };
  }
  return { ticketKey, ticket, forced: designated ? [] : ['designation'] };
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
