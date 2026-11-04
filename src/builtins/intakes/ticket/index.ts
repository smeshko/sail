// The built-in `ticket` intake's body: it claims the run's ticket and comments with the run id, reporting the claim's
// record to the call's result, then fetches the ticket through the TicketSource, so the brief shows it claimed. It
// splits the description into the request and the acceptance criteria, and leaves `ticket.json` and `brief.md` in the
// call directory. A claim lost to another start is a PortError, so the intake ends in `error`. Every string
// the provider returned is wrapped as untrusted input in the brief. It returns the run's input, unvalidated: the engine
// checks it against `TicketInput`. A later try completes an earlier claim whose comment never posted.
//
// The ticket key the brief prints bare, and the one in the output, is the run's own: the source's, never the one the
// provider sent back. An abort cuts the fetch, never the claim or its comment.
//
// The files the ticket's provider hosts are downloaded into `attachments/` in the call directory, each attachment
// carrying the `path` it landed at or a `skipped` note; a link to elsewhere is left as it is.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadAttachments } from '../../../engine/attachments';
import { render, untrustedInput } from '../../../engine/render';
import { claimSource } from '../../../engine/source';
import { getTicket } from '../../../ports/ticket-source';
import type { Attachment, Ticket } from '../../../ports/types';
import type { IntakeContext } from '../index';
import { splitDescription } from './criteria';

/** `ticket.json`: the port's ticket, with the criteria the description listed. */
export type TicketFile = Omit<Ticket, 'attachments'> & {
  acceptanceCriteria: string[];
  attachments: TicketAttachment[];
};

/** An attachment with where its file landed under the call directory, or why it didn't. */
export type TicketAttachment = Attachment & { path?: string; skipped?: string };

/** The brief's values: every provider string marked with where it came from, so the renderer wraps each one. */
function briefValues(
  key: string,
  ticket: Ticket,
  attachments: readonly TicketAttachment[],
  request: string,
  criteria: readonly string[],
) {
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
    attachments: attachments.map((attachment, index) => ({
      name: untrustedInput(attachment.name, from(`attachment ${index + 1} name`)),
      url: untrustedInput(attachment.url, from(`attachment ${index + 1}`)),
      path: untrustedInput(attachment.path ?? '', from(`attachment ${index + 1} path`)),
      skipped: untrustedInput(attachment.skipped ?? '', from(`attachment ${index + 1} note`)),
    })),
    comments: ticket.comments.map((comment, index) => ({
      author: untrustedInput(comment.author, from(`comment ${index + 1} author`)),
      body: untrustedInput(comment.body, from(`comment ${index + 1}`)),
    })),
  };
}

/**
 * Runs the `ticket` intake once: the claim and its comment, one `get`, the two files, the output. A failed port call
 * leaves it as a PortError, and so does an answer that is no Ticket, before any file is written.
 */
export async function ticketIntake(context: IntakeContext): Promise<unknown> {
  const { source } = context;
  if (source.kind !== 'ticket')
    throw new Error(`the ticket intake reads a ticket, not a source of kind ${source.kind}`);
  const key = source.ticketKey;
  const claim = await claimSource({
    ticketKey: key,
    runId: context.runId,
    ticketSource: context.ticketSource,
    forced: source.forced,
    claimedEarlier: context.claimedEarlier,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  context.record({ claim });
  const ticket = await getTicket(context.ticketSource, key, context.signal);
  const { request, criteria } = splitDescription(ticket.description);

  const outcomes = await downloadAttachments(
    context.ticketSource,
    key,
    ticket.attachments,
    join(context.out, 'attachments'),
    context.signal,
  );
  const attachments: TicketAttachment[] = outcomes.map((each) => ({
    name: each.name,
    url: each.url,
    ...(each.mimeType === undefined ? {} : { mimeType: each.mimeType }),
    ...(each.file === undefined ? {} : { path: `attachments/${each.file}` }),
    ...(each.skipped === undefined ? {} : { skipped: each.skipped }),
  }));

  const file: TicketFile = { ...ticket, acceptanceCriteria: criteria, attachments };
  writeFileSync(join(context.out, 'ticket.json'), `${JSON.stringify(file, null, 2)}\n`);
  const template = readFileSync(join(import.meta.dir, 'brief.md'), 'utf8');
  writeFileSync(
    join(context.out, 'brief.md'),
    render(template, briefValues(key, ticket, attachments, request, criteria)).text,
  );

  return {
    ticketKey: key,
    title: ticket.title,
    url: ticket.url,
    acceptanceCriteria: criteria,
    labels: ticket.labels,
    links: ticket.links,
    attachments,
  };
}
