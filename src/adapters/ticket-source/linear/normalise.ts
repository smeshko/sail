// Linear's answers as sail's Ticket, and Linear's state types as sail's. Free of I/O, so its mapping takes plain values.
// Stub: the mapping is written in TASK-003.
import type { Ticket, TicketStateType } from '../../../ports/types';

/** A Linear issue node, as FetchIssue answers it, as a Ticket whose `raw` is the node. */
export function toTicket(_node: unknown): Ticket {
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

/**
 * sail's state type for a Linear state type: backlog and unstarted are unstarted, started is started, completed is
 * completed, canceled and duplicate are canceled. Any other type, triage included, is refused with a PortError `invalid`
 * that names it.
 */
export function stateTypeOf(_linearType: string): TicketStateType {
  return 'unstarted';
}
