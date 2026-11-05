// hand-over-ticket: a run that stopped on something no run of it can change, such as an agent blocked on a requirement
// the workspace can't meet, leaves its ticket to a human. It comments why, takes the designation label off, so the
// watcher doesn't start the ticket again, and puts NEEDS_HUMAN on; a workflow that claimed the ticket also has it
// moved back to unstarted. Putting the designation label back runs it again. Shared: factory and groom hand over.
import { script, value, z } from 'sail';

/** The label a ticket left to a human carries. */
export const NEEDS_HUMAN = 'needs-human';

export const handOverTicket = script('hand-over-ticket', {
  run: './run.sh',
  ports: ['ticket-source'],
  consumes: {
    ticketKey: value(z.string()),
    label: value(z.string()),
    reason: value(z.string()),
    workflow: value(z.string()),
    unstart: value(z.boolean()),
  },
  output: z.object({ handedOver: z.boolean() }),
  exitCodes: { passed: [0], failed: [] },
});
