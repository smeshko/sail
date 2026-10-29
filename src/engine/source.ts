// A run's source, checked, and the claim on its ticket: on the TicketSource port alone. `resolveSource()` turns the
// argument a run was started with into a ticket key and its ticket, or a refusal, and only reads: a start writes
// nothing to the ticket. `claimSource()` is the claim the built-in `ticket` intake makes inside `intake#1`: it moves
// the ticket to In Progress, by the claim or by a forced move, and comments with the run id. A failure partway throws a
// PortError saying where the ticket stands.
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
    : state.type === 'unstarted'
      ? `the ticket is not in a pick-up state: it is ${state.name}. ${FORCE}`
      : `the ticket is not unstarted: it is ${state.name}. ${FORCE}`;
const lostClaim = (state: TicketState) =>
  state.type === 'started'
    ? `the ticket is already claimed: it became ${state.name} while sail was starting. ${FORCE}`
    : state.type === 'unstarted'
      ? `the ticket is not in a pick-up state: it became ${state.name} while sail was starting. ${FORCE}`
      : `the ticket is not unstarted: it became ${state.name} while sail was starting. ${FORCE}`;
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
  /** The checks `--force` overrode: `designation` for a missing label, then `state` for a ticket not in a pick-up state. */
  forced: Forced[];
}

/**
 * The ticket `ref` names, fetched and checked: it carries `label`, and it is in a pick-up state, each unless `force`. A ticket
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
    if (!ticketSource.canPickUp(ticket)) return { refused: notUnstarted(ticket.state) };
  }
  const forced: Forced[] = [];
  if (!designated) forced.push('designation');
  if (force && !ticketSource.canPickUp(ticket)) forced.push('state');
  return { ticketKey, ticket, forced };
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

/** The run the ticket's latest claim comment names, if any. */
export function claimedBy(ticket: Pick<Ticket, 'comments'>): string | undefined {
  for (const comment of ticket.comments.toReversed()) {
    const match = /^sail run (\S+) started$/.exec(comment.body.trim());
    if (match) return match[1];
  }
  return undefined;
}

export interface ClaimSourceOptions {
  ticketKey: string;
  /** The run the comment names. */
  runId: string;
  ticketSource: TicketSource;
  /** The checks `--force` overrode at the start: with `state`, a claim that didn't take moves the ticket instead. */
  forced: readonly Forced[];
  /** An earlier try of this call claimed the ticket, as the run's stream records. */
  claimedEarlier?: boolean;
}

/**
 * The claim the ticket intake makes: claims the ticket, then comments with the run id. The claim's own answer decides,
 * not an earlier fetch: two starts can both read a ticket as in a pick-up state, and one claim takes. A claim that
 * didn't take is this run's own earlier claim when the ticket's latest claim comment names the run, or when
 * `claimedEarlier` records it and no claim comment names a newer run (or an unrecognised run id). A missing comment is
 * posted. Otherwise it moves the ticket to In Progress through `update` when `forced` has `state`, and is lost when it
 * doesn't. A port call that fails throws its PortError, a lost claim a `conflict`, and nothing is moved back.
 */
export async function claimSource(options: ClaimSourceOptions): Promise<ClaimRecord> {
  const { ticketKey, runId, ticketSource, forced, claimedEarlier = false } = options;
  const answer = await ticketSource.claim(ticketKey);
  let claimed = answer.claimed;
  let state = stateOf(answer.state);
  if (!claimed) {
    const ticket = await getTicket(ticketSource, ticketKey);
    const owner = claimedBy(ticket);
    if (owner === runId) return { claimed: true, state: stateOf(ticket.state) };
    // Run ids end in time-ordered ULIDs. A previous run's comment survives a return to a pick-up state;
    // it is not evidence against this run's recorded claim. Unknown ids remain conflicts.
    const olderOwner =
      owner?.startsWith(`${ticketKey}-`) &&
      /^[0-9A-HJKMNP-TV-Z]{26}$/.test(owner.slice(ticketKey.length + 1)) &&
      owner < runId;
    if (claimedEarlier && (owner === undefined || olderOwner)) {
      claimed = true;
      state = stateOf(ticket.state);
    } else {
      if (!forced.includes('state')) throw new PortError('ticketSource', 'claim', 'conflict', lostClaim(state));
      state = stateOf((await ticketSource.update(ticketKey, { state: 'in-progress' })).state);
    }
  }
  try {
    await ticketSource.comment(ticketKey, claimComment(runId));
  } catch (error) {
    if (!(error instanceof PortError)) throw error;
    const failure = `${error.message} (${error.code})`;
    throw new PortError('ticketSource', 'comment', error.code, commentFailed(state, runId, failure));
  }
  return { claimed, state };
}
