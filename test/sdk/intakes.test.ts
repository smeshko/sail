import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TicketInput, ticket } from '../../src/sdk/intakes';
import { isUntrusted } from '../../src/sdk/untrusted';

const goldenIntake = join(
  import.meta.dir,
  '..',
  'fixtures',
  'runs',
  'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N',
  '00-intake',
  'call-1',
  'result.json',
);

test('ticket is the built-in intake for ticket sources', () => {
  expect(ticket).toMatchObject({
    kind: 'intake',
    name: 'ticket',
    accepts: ['ticket'],
    produces: { 'ticket.json': 'file', 'brief.md': 'file' },
  });
  expect(ticket.output).toBe(TicketInput);
  expect(ticket).not.toHaveProperty('steps');
});

test('TicketInput accepts the golden intake output, its labels, links and attachments included', () => {
  const { output } = JSON.parse(readFileSync(goldenIntake, 'utf8'));
  expect(Object.keys(output)).toEqual([
    'ticketKey',
    'title',
    'url',
    'acceptanceCriteria',
    'labels',
    'links',
    'attachments',
  ]);
  expect(TicketInput.parse(output)).toEqual(output);
});

test('TicketInput refuses a ticket without its acceptance criteria, its labels, its links or its attachments', () => {
  const result = TicketInput.safeParse({ ticketKey: 'FAKE-1', title: 'Title', url: 'fake://tickets/FAKE-1' });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
    'acceptanceCriteria',
    'labels',
    'links',
    'attachments',
  ]);
  const whole = {
    ticketKey: 'FAKE-1',
    title: 'Title',
    url: 'fake://tickets/FAKE-1',
    acceptanceCriteria: ['one'],
    labels: ['cli'],
    links: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b', title: 'B' }],
    attachments: [{ name: 'a.png', url: 'https://example.com/a.png' }],
  };
  expect<unknown>(TicketInput.parse(whole)).toEqual(whole);
  // A link's URL is text the provider sent, so it is marked and not checked. The ticket's own URL is checked.
  expect(TicketInput.safeParse({ ...whole, links: [{ url: 'not a url' }] }).success).toBe(true);
  expect(TicketInput.safeParse({ ...whole, url: 'not a url' }).error?.issues.map((issue) => issue.path)).toEqual([
    ['url'],
  ]);
});

test("TicketInput marks as untrusted its title, each criterion, each label, each link's URL and title and each attachment's name and URL, and nothing else", () => {
  const { shape } = TicketInput;
  expect(Object.keys(shape)).toEqual([
    'ticketKey',
    'title',
    'url',
    'acceptanceCriteria',
    'labels',
    'links',
    'attachments',
  ]);
  const link = shape.links.element.shape;
  const attachment = shape.attachments.element.shape;
  expect({
    ticketKey: isUntrusted(shape.ticketKey),
    title: isUntrusted(shape.title),
    url: isUntrusted(shape.url),
    criterion: isUntrusted(shape.acceptanceCriteria.element),
    label: isUntrusted(shape.labels.element),
    linkUrl: isUntrusted(link.url),
    linkTitle: isUntrusted(link.title.unwrap()),
    attachmentName: isUntrusted(attachment.name),
    attachmentUrl: isUntrusted(attachment.url),
    mimeType: isUntrusted(attachment.mimeType.unwrap()),
  }).toEqual({
    ticketKey: false,
    title: true,
    url: false,
    criterion: true,
    label: true,
    linkUrl: true,
    linkTitle: true,
    attachmentName: true,
    attachmentUrl: true,
    mimeType: false,
  });
  expect(Object.keys(link)).toEqual(['url', 'title']);
  expect(Object.keys(attachment)).toEqual(['name', 'url', 'mimeType']);
});
