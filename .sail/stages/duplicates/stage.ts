// duplicates: names the team's other open tickets a ticket may duplicate, each with Jev's probability. One request asks
// a `noul` per other ticket, in one `sail port jev ask`; a ticket answered under 0.5 is left out. Shared: groom judges
// a ticket with it, and anything that files a ticket can check it against the backlog first.
import { script, untrusted, value, z } from 'sail';

/** Other tickets the given one may duplicate, each with how sure Jev is. */
export const Duplicates = z.object({
  candidates: z.array(z.object({ ticketKey: z.string(), confidence: z.number().min(0).max(1), why: z.string() })),
});

/** The ticket to check: its ticket key, which is left out of the others, and what people wrote about it. */
export const DuplicateTicket = z.object({
  ticketKey: z.string(),
  title: untrusted(),
  description: untrusted(),
});

export const duplicates = script('duplicates', {
  run: './run.sh',
  consumes: { ticket: value(DuplicateTicket) },
  // The request sent to Jev, or the one that would have been sent when no other ticket is open.
  produces: { 'request.json': 'file' },
  output: Duplicates,
  exitCodes: { passed: [0], failed: [] },
});
