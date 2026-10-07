// The `sail/intakes` entry: the built-in intakes a repository's workflows name. A repository may shadow one.

import { z } from 'zod';
import { intake } from './intake';
import { untrusted } from './untrusted';

/**
 * A ticket as the `ticket` intake hands it to the workflow: `run.input`. Every string the provider returned is marked
 * untrusted, the ticket's URL included, which is checked as a URL too. The ticket key is the run's own.
 */
export const TicketInput = z.object({
  ticketKey: z.string(),
  title: untrusted(),
  url: untrusted().check(z.url()),
  acceptanceCriteria: z.array(untrusted()),
  labels: z.array(untrusted()),
  links: z.array(z.object({ url: untrusted(), title: untrusted().optional() })),
  attachments: z.array(z.object({ name: untrusted(), url: untrusted(), mimeType: untrusted().optional() })),
});
export type TicketInput = z.infer<typeof TicketInput>;

/** The built-in intake for ticket sources. The engine runs its body, which leaves `ticket.json` and `brief.md`. */
export const ticket = intake('ticket', {
  accepts: ['ticket'],
  output: TicketInput,
  produces: { 'ticket.json': 'file', 'brief.md': 'file' },
});
