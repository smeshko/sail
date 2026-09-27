import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TicketInput, ticket } from '../../src/sdk/intakes';

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

test('TicketInput accepts the golden intake output', () => {
  const { output } = JSON.parse(readFileSync(goldenIntake, 'utf8'));
  expect(TicketInput.parse(output)).toEqual(output);
});

test('TicketInput refuses a ticket without its acceptance criteria', () => {
  const result = TicketInput.safeParse({ ticketKey: 'FAKE-1', title: 'Title', url: 'fake://tickets/FAKE-1' });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['acceptanceCriteria']);
});
