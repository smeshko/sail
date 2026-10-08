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
const lostClaim = (state: TicketState) =>
  `the ticket is already claimed: it became ${state.name} while sail was starting. ${FORCE}`;
const commentFailed = (state: TicketState, runId: string, failure: string) =>
  `the ticket is now ${state.name}, but the comment naming run ${runId} failed: ${failure}. --force runs it`;

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

/**
 * A state as the run header records it and the stream reports it: the port's two fields. An adapter may answer with
 * more, such as the provider's id for the state, and `sail.run.v1` takes none of it.
 */
const stateOf = ({ type, name }: TicketState): TicketState => ({ type, name });

/** The comment a run leaves on its ticket as it starts. */
export function claimComment(runId: string): string {
  return `sail run ${runId} started`;
}

export interface ClaimSourceOptions {
  ticketKey: string;
  /** The run the comment names, minted before the claim. */
  runId: string;
  ticketSource: TicketSource;
  /** Moves a ticket whose claim didn't take, where a run nobody forced is refused. */
  force?: boolean;
}

export interface ClaimedSource {
  claim: ClaimRecord;
  /** `state` when `--force` overrode a claim that didn't take. */
  forced: Forced[];
  /**
   * What was done to the ticket, in order, for the run's stream. Built from the port's answers: the adapter emits its
   * own as it is called, but no run is attached to hear them yet.
   */
  events: ProviderEvent[];
}

/**
 * Claims the ticket, moves it to In Progress through `update` when the claim didn't take and `force` is set, then
 * comments with the run id. The claim's own answer decides, not an earlier fetch: two starts can both read a ticket as
 * unstarted, and one claim takes. Each port call that fails refuses, and nothing is moved back.
 */
export async function claimSource(options: ClaimSourceOptions): Promise<ClaimedSource | { refused: string }> {
  const { ticketKey, runId, ticketSource, force = false } = options;
  const events: ProviderEvent[] = [];
  let claimed: boolean;
  let state: TicketState;
  try {
    const answer = await ticketSource.claim(ticketKey);
    claimed = answer.claimed;
    state = stateOf(answer.state);
  } catch (error) {
    return { refused: refusalOf(error) };
  }
  if (claimed) events.push({ type: 'ticket:claimed', ticketKey, state: { ...state } });
  else {
    if (!force) return { refused: lostClaim(state) };
    const change = { state: 'in-progress' } as const;
    try {
      state = stateOf((await ticketSource.update(ticketKey, change)).state);
    } catch (error) {
      return { refused: refusalOf(error) };
    }
    events.push({ type: 'ticket:updated', ticketKey, change, state: { ...state } });
  }
  const body = claimComment(runId);
  try {
    await ticketSource.comment(ticketKey, body);
  } catch (error) {
    return { refused: commentFailed(state, runId, refusalOf(error)) };
  }
  events.push({ type: 'ticket:commented', ticketKey, body });
  return { claim: { claimed, state: { ...state } }, forced: claimed ? [] : ['state'], events };
}
