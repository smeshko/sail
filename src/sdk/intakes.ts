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

/**
 * A pull request as the `pr` intake hands it to the workflow: `run.input`. Every string the host returned is marked
 * untrusted: the title, body, author, branch names, labels, comments and URL, which is checked as a URL too. The head
 * sha is the run's own, the one its workspace starts at, and the ticket key is there only when the pull request's ticket
 * marker matches its head branch.
 */
const PrInputFinal = z.object({
  number: z.number().int().positive(),
  url: untrusted().check(z.url()),
  title: untrusted(),
  body: untrusted(),
  author: untrusted(),
  base: untrusted(),
  head: untrusted(),
  headSha: z.string(),
  baseSha: z.string(),
  draft: z.boolean(),
  labels: z.array(untrusted()),
  comments: z.array(z.object({ author: untrusted(), body: untrusted() })),
  ticketKey: z.string().optional(),
});
export const PrInput = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  base: z.string(),
  head: z.string(),
  headSha: z.string(),
  baseSha: z.string(),
  draft: z.boolean(),
  labels: z.array(z.string()),
  comments: z.array(z.object({ author: z.string(), body: z.string() })),
  ticketKey: z.string().optional(),
}) as unknown as typeof PrInputFinal;
export type PrInput = z.infer<typeof PrInput>;

/**
 * The built-in intake for pull requests. The engine runs its body, which leaves `pr.json`, `diff.patch`, the change
 * from the merge base to the head sha, and `brief.md`.
 */
export const pr = intake('pr', {
  accepts: ['pr'],
  output: PrInput,
  produces: { 'pr.json': 'file', 'diff.patch': 'file', 'brief.md': 'file' },
});
