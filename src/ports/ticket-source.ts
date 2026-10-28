// The TicketSource port: the ticket system in sail's words, whatever the provider. A ticket's state is reported by type,
// and moved by the four moves ADR-0015 names. The claim is the only move that can not happen, and says so as a value.
import type { ProviderEmit } from '../events/types';
import { PortError } from './errors';
import {
  type Attached,
  type ClaimResult,
  type Created,
  type Edited,
  type ListedTicket,
  type Moved,
  type Posted,
  type Relabelled,
  type Related,
  Ticket,
  type TicketMove,
  type TicketRelation,
  type TicketSourceCapabilities,
  type TicketStateType,
} from './types';

/** What every adapter factory takes beside its own options. */
export interface ProviderOptions {
  /** Where the adapter emits its provider events. The caller stamps each one. */
  readonly emit?: ProviderEmit;
  /** The clock behind durations and timestamps. */
  readonly now?: () => Date;
}

/** A ticket `create` files: its labels by name. */
export interface NewTicket {
  readonly title: string;
  readonly description: string;
  readonly labels: readonly string[];
}

/** A file `attach` attaches: its bytes, with the name and content type it is stored under. */
export interface NewAttachment {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** What the ticket shows the attachment as. Its name unless given. */
  readonly title?: string;
}

/** What `list` keeps: tickets in a state of this type, and carrying this label. Each is left out to match any. */
export interface TicketFilter {
  readonly state?: TicketStateType;
  readonly label?: string;
}

/** A relation `relate` makes: its kind, and the key of the other ticket. */
export interface TicketRelationChange {
  readonly kind: TicketRelation;
  readonly to: string;
}

/** What `edit` sets: a new title, a new description, or both. */
export interface TicketEdit {
  readonly title?: string;
  readonly description?: string;
}

/** The largest file `attach` takes: 20 MiB. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Refuses a file `attach` can't send, before any request: no name, a content type that isn't one (`type/subtype`), no
 * bytes, or more than `MAX_ATTACHMENT_BYTES`. A PortError of `attach`, code `invalid`.
 */
export function checkAttachment(file: NewAttachment): void {
  const problem =
    file.name.trim() === ''
      ? 'the file has no name'
      : !/^[\w.+-]+\/[\w.+-]+(;.*)?$/.test(file.contentType)
        ? `${JSON.stringify(file.contentType)} is not a content type`
        : file.bytes.byteLength === 0
          ? `${file.name} is empty`
          : file.bytes.byteLength > MAX_ATTACHMENT_BYTES
            ? `${file.name} is ${file.bytes.byteLength} bytes, over the ${MAX_ATTACHMENT_BYTES} an attachment may be`
            : undefined;
  if (problem !== undefined) throw new PortError('ticketSource', 'attach', 'invalid', problem);
}

export interface TicketSource {
  readonly name: string;
  /** The ticket key `ref` names: a ticket key, or a URL the provider owns. Undefined for anything else. */
  parseKey(ref: string): string | undefined;
  /** The ticket with its comments, links and attachments. Emits `ticket:fetched`. */
  get(ticketKey: string): Promise<Ticket>;
  isDesignated(ticket: Ticket, label: string): boolean;
  /** Whether the ticket is in one of this source's pick-up states: by default any state it reads as unstarted. */
  canPickUp(ticket: Ticket): boolean;
  /** The designated tickets that are in a pick-up state. */
  listDesignated(label: string): Promise<Ticket[]>;
  /**
   * The team's tickets in a state of the filter's type and carrying its label, sorted by ticket number. A state that
   * isn't a `TicketStateType` rejects as `invalid`. Emits nothing.
   */
  list(filter: TicketFilter): Promise<ListedTicket[]>;
  /** Moves a ticket in a pick-up state to in progress. Emits `ticket:claimed` only when the claim took (D4). */
  claim(ticketKey: string): Promise<ClaimResult>;
  /** Moves the ticket, and returns the state the provider reports. Emits `ticket:updated`. */
  update(ticketKey: string, change: { readonly state: TicketMove }): Promise<Moved>;
  /** Emits `ticket:commented`. */
  comment(ticketKey: string, body: string): Promise<Posted>;
  /** Files a new ticket with these labels, in whatever state the provider starts one in. Emits `ticket:created`. */
  create(ticket: NewTicket): Promise<Created>;
  /**
   * Adds the label to the ticket and returns the labels it carries then. Idempotent: a label it already carries sends
   * nothing and emits nothing. A label the team lacks rejects as `invalid` before any change. Emits `ticket:labelled`.
   */
  addLabel(ticketKey: string, label: string): Promise<Relabelled>;
  /**
   * Removes the label from the ticket and returns the labels it carries then. Idempotent: a label it lacks sends
   * nothing and emits nothing. A label the team lacks rejects as `invalid` before any change. Emits `ticket:unlabelled`.
   */
  removeLabel(ticketKey: string, label: string): Promise<Relabelled>;
  /**
   * Relates the ticket to another: `blocks` means the ticket blocks `to`, `duplicate` that it duplicates `to`, which also
   * moves the ticket to a canceled state. Both tickets must exist (`not_found`); relating a ticket to itself, or a kind
   * that isn't a `TicketRelation`, rejects as `invalid`, and nothing changes. Emits `ticket:related`.
   */
  relate(ticketKey: string, change: TicketRelationChange): Promise<Related>;
  /**
   * Sets the ticket's title, description, or both. A change naming neither rejects as `invalid` before any request.
   * Emits `ticket:edited`, with the fields it set.
   */
  edit(ticketKey: string, change: TicketEdit): Promise<Edited>;
  /**
   * Uploads the file and attaches it to the ticket, after `checkAttachment()` passes it. Emits `ticket:attached`.
   */
  attach(ticketKey: string, file: NewAttachment): Promise<Attached>;
  capabilities(): TicketSourceCapabilities;
}

/**
 * The ticket `source.get()` answers with, checked against the port's schema: an adapter's answer crosses a trust
 * boundary. An answer that is no Ticket is a PortError of `get`, code `invalid`, saying where it isn't one.
 */
export async function getTicket(source: TicketSource, ticketKey: string): Promise<Ticket> {
  const answer: unknown = await source.get(ticketKey);
  const parsed = Ticket.safeParse(answer);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const where = [issue?.path.join('.'), issue?.message].filter(Boolean).join(' ');
  throw new PortError('ticketSource', 'get', 'invalid', `ticket ${ticketKey} is not a Ticket: ${where}`, answer);
}
