// A Linear issue node as the port's Ticket: pure functions, no I/O. Linear's seven state types fold into sail's four
// (DECISIONS D4), and a type sail doesn't know is an error rather than a guess. Files uploaded to Linear show up only as
// links in the text, so they are found there and listed beside Linear's own attachments.
//
// TDD stub (linear-ticket-source TASK-002): the signatures are final, the bodies answer wrong.
import type { Ticket, TicketStateType } from '../../ports/types';

/** The fields of a comment, for the ticket query and the comment pages. */
export const COMMENT_FIELDS = '';

/** The fields of a ticket every query selects. */
export const TICKET_FIELDS = '';

/** Linear's state type as sail's, or a PortError of `op` naming a type sail doesn't know. */
export function stateTypeOf(_linearType: string, _op: string): TicketStateType {
  return 'unstarted';
}

/** The ticket `node` describes, with `comments`, every page of them, in the order they were written. */
export function toTicket(_node: unknown, _comments: readonly unknown[], _op: string): Ticket {
  return {
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
  };
}
