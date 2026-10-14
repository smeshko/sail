// A Linear issue node as the port's Ticket: pure functions, no I/O. Linear's seven state types fold into sail's four
// (DECISIONS D4), and a type sail doesn't know is an error rather than a guess. Files uploaded to Linear show up only as
// links in the text, so they are found there and listed beside Linear's own attachments.
import { z } from 'zod';
import { PortError } from '../../ports/errors';
import type { Attachment, Comment, Link, Ticket, TicketStateType } from '../../ports/types';

/** The fields of a comment, for the ticket query and the comment pages. */
export const COMMENT_FIELDS = 'id body createdAt user { name } botActor { name }';

/** The fields of a ticket every query selects. */
export const TICKET_FIELDS = `id identifier number title description url priority
  state { id name type }
  team { key }
  assignee { name email }
  labels(first: 250) { nodes { name } }
  comments(first: 250) { nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage endCursor } }
  relations(first: 250) { nodes { type relatedIssue { identifier title url } } }
  inverseRelations(first: 250) { nodes { type issue { identifier title url } } }
  attachments(first: 250) { nodes { title url } }`;

const STATE_TYPES: Record<string, TicketStateType> = {
  triage: 'unstarted',
  backlog: 'unstarted',
  unstarted: 'unstarted',
  started: 'started',
  completed: 'completed',
  canceled: 'canceled',
  duplicate: 'canceled',
};

/** Linear's state type as sail's, or a PortError of `op` naming a type sail doesn't know. */
export function stateTypeOf(linearType: string, op: string): TicketStateType {
  const type = STATE_TYPES[linearType];
  if (type === undefined) {
    throw new PortError('ticketSource', op, 'invalid', `Linear's state type '${linearType}' is not one sail knows`);
  }
  return type;
}

const Related = z.object({ identifier: z.string(), title: z.string(), url: z.string() });

export const LinearComment = z.object({
  body: z.string(),
  createdAt: z.string(),
  user: z.object({ name: z.string() }).nullish(),
  botActor: z.object({ name: z.string().nullish() }).nullish(),
});
export type LinearComment = z.infer<typeof LinearComment>;

const LinearTicketNode = z.object({
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  state: z.object({ name: z.string(), type: z.string() }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  relations: z.object({ nodes: z.array(z.object({ type: z.string(), relatedIssue: Related })) }),
  inverseRelations: z.object({ nodes: z.array(z.object({ type: z.string(), issue: Related })) }),
  attachments: z.object({ nodes: z.array(z.object({ title: z.string(), url: z.string() })) }),
});

const UPLOAD = /!?\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;

/** Every file uploaded to Linear that `text` links, as a Markdown link or image. */
function uploadsIn(text: string): Attachment[] {
  return [...text.matchAll(UPLOAD)].map(([, label = '', url = '']) => ({
    name: label !== '' ? label : (new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? url),
    url,
  }));
}

const authorOf = (comment: LinearComment): string => comment.user?.name ?? comment.botActor?.name ?? 'unknown';

/** The ticket `node` describes, with `comments`, every page of them, in the order they were written. */
export function toTicket(node: unknown, comments: readonly unknown[], op: string): Ticket {
  const parsed = LinearTicketNode.safeParse(node);
  const parsedComments = z.array(LinearComment).safeParse(comments);
  const failed = !parsed.success ? parsed.error : !parsedComments.success ? parsedComments.error : undefined;
  if (failed !== undefined || !parsed.success || !parsedComments.success) {
    const issue = failed?.issues[0];
    const where = [!parsed.success ? '' : 'comments', ...(issue?.path ?? [])].filter((part) => part !== '').join('.');
    throw new PortError(
      'ticketSource',
      op,
      'invalid',
      `Linear sent a ticket whose ${where} is missing or malformed`,
      node,
    );
  }
  const ticket = parsed.data;
  const sorted = [...parsedComments.data].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const description = ticket.description ?? '';
  const links: Link[] = [
    ...ticket.relations.nodes.map(({ type, relatedIssue: to }) => ({
      url: to.url,
      title: `${type} ${to.identifier}: ${to.title}`,
    })),
    ...ticket.inverseRelations.nodes.map(({ type, issue: from }) => ({
      url: from.url,
      title: `${type} ${from.identifier}: ${from.title}`,
    })),
    ...ticket.attachments.nodes.map(({ title, url }) => ({ url, title })),
  ];
  const files = [description, ...sorted.map((comment) => comment.body)].flatMap(uploadsIn);
  const attachments: Attachment[] = [...ticket.attachments.nodes.map(({ title, url }) => ({ name: title, url }))];
  for (const file of files) if (!attachments.some((known) => known.url === file.url)) attachments.push(file);
  const raw = node as Record<string, unknown>;
  const rawComments = (raw.comments ?? {}) as Record<string, unknown>;
  return {
    ticketKey: ticket.identifier,
    title: ticket.title,
    url: ticket.url,
    description,
    state: { type: stateTypeOf(ticket.state.type, op), name: ticket.state.name },
    labels: ticket.labels.nodes.map((label) => label.name),
    comments: sorted.map(
      (comment): Comment => ({ author: authorOf(comment), body: comment.body, createdAt: comment.createdAt }),
    ),
    links,
    attachments,
    raw: { ...raw, comments: { ...rawComments, nodes: [...comments] } },
  };
}
