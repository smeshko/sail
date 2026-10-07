// The built-in `ticket` intake's body: it fetches the run's ticket through the TicketSource, splits the description into
// the request and the acceptance criteria, and leaves `ticket.json` and `brief.md` in the call directory. Every string
// the provider returned is wrapped as untrusted input in the brief. It returns the run's input, unvalidated: the engine
// checks it against `TicketInput`.
//
// The ticket key the brief prints bare, and the one in the output, is the run's own: the source's, never the one the
// provider sent back.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, untrustedInput } from '../../../engine/render';
import { getTicket } from '../../../ports/ticket-source';
import type { Ticket } from '../../../ports/types';
import type { IntakeContext } from '../index';
import { splitDescription } from './criteria';

/** `ticket.json`: the port's ticket, with the criteria the description listed. */
export type TicketFile = Ticket & { acceptanceCriteria: string[] };

/** The brief's values: every provider string marked with where it came from, so the renderer wraps each one. */
function briefValues(key: string, ticket: Ticket, request: string, criteria: readonly string[]) {
  const from = (what: string) => `ticket ${key}, ${what}`;
  return {
    ticket: {
      key,
      title: untrustedInput(ticket.title, from('title')),
      request: untrustedInput(request, from('description')),
      url: untrustedInput(ticket.url, from('url')),
      state: ticket.state.type,
    },
    criteria: criteria.map((text, index) => untrustedInput(text, from(`acceptance criterion ${index + 1}`))),
    labels: ticket.labels.map((label, index) => untrustedInput(label, from(`label ${index + 1}`))),
    links: ticket.links.map((link, index) => ({
      url: untrustedInput(link.url, from(`link ${index + 1}`)),
      title: untrustedInput(link.title ?? '', from(`link ${index + 1} title`)),
    })),
    attachments: ticket.attachments.map((attachment, index) => ({
      name: untrustedInput(attachment.name, from(`attachment ${index + 1} name`)),
      url: untrustedInput(attachment.url, from(`attachment ${index + 1}`)),
    })),
    comments: ticket.comments.map((comment, index) => ({
      author: untrustedInput(comment.author, from(`comment ${index + 1} author`)),
      body: untrustedInput(comment.body, from(`comment ${index + 1}`)),
    })),
  };
}

/**
 * Runs the `ticket` intake once: one `get`, the two files, the output. A failed port call leaves it as a PortError, and
 * so does an answer that is no Ticket, before any file is written.
 */
export async function ticketIntake(context: IntakeContext): Promise<unknown> {
  const key = context.source.ticketKey;
  const ticket = await getTicket(context.ticketSource, key);
  const { request, criteria } = splitDescription(ticket.description);

  const file: TicketFile = { ...ticket, acceptanceCriteria: criteria };
  writeFileSync(join(context.out, 'ticket.json'), `${JSON.stringify(file, null, 2)}\n`);
  const template = readFileSync(join(import.meta.dir, 'brief.md'), 'utf8');
  writeFileSync(join(context.out, 'brief.md'), render(template, briefValues(key, ticket, request, criteria)).text);

  return {
    ticketKey: key,
    title: ticket.title,
    url: ticket.url,
    acceptanceCriteria: criteria,
    labels: ticket.labels,
    links: ticket.links,
    attachments: ticket.attachments,
  };
}
