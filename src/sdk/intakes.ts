// The `sail/intakes` entry: the built-in intakes a repository's workflows name. A repository may shadow one.

import { z } from 'zod';
import { intake } from './intake';
import { untrusted } from './untrusted';

const Shape = z.object({
  ticketKey: z.string(),
  title: untrusted(),
  url: z.url(),
  acceptanceCriteria: z.array(untrusted()),
  labels: z.array(untrusted()),
  links: z.array(z.object({ url: untrusted(), title: untrusted().optional() })),
  attachments: z.array(z.object({ name: untrusted(), url: untrusted(), mimeType: z.string().optional() })),
});

/** A ticket as the `ticket` intake hands it to the workflow: `run.input`. */
export const TicketInput = Shape.omit({ labels: true, links: true, attachments: true }) as unknown as typeof Shape;
export type TicketInput = z.infer<typeof TicketInput>;

/** The built-in intake for ticket sources. It leaves `ticket.json` and `brief.md`. Declared here; its body comes later. */
export const ticket = intake('ticket', {
  accepts: ['ticket'],
  output: TicketInput,
  produces: { 'ticket.json': 'file', 'brief.md': 'file' },
});
