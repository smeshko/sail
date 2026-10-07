// The `sail/intakes` entry: the built-in intakes a repository's workflows name. A repository may shadow one.

import { z } from 'zod';
import { intake } from './intake';
import { untrusted } from './untrusted';

/**
 * A ticket as the `ticket` intake hands it to the workflow: `run.input`. Every string the provider returned is marked
 * untrusted, apart from the URL: `untrusted()` is a plain string schema, so marking it would drop the URL check.
 */
export const TicketInput = z.object({
  ticketKey: z.string(),
  title: untrusted(),
  url: z.url(),
  acceptanceCriteria: z.array(untrusted()),
  labels: z.array(untrusted()),
  links: z.array(z.object({ url: untrusted(), title: untrusted().optional() })),
  attachments: z.array(z.object({ name: untrusted(), url: untrusted(), mimeType: z.string().optional() })),
});
export type TicketInput = z.infer<typeof TicketInput>;

/** The built-in intake for ticket sources. The engine runs its body, which leaves `ticket.json` and `brief.md`. */
export const ticket = intake('ticket', {
  accepts: ['ticket'],
  output: TicketInput,
  produces: { 'ticket.json': 'file', 'brief.md': 'file' },
});
