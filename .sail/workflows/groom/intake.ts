// read-ticket: groom's own intake. The built-in `ticket` intake claims, which moves the ticket to In Progress; this one
// only reads: the ticket, and the team's other open tickets for the duplicate check. Every passage a person wrote is
// wrapped as untrusted input in the files it writes.
import { intake, script, value, z } from 'sail';
import { GroomInput } from './schemas';

const read = script('read', {
  run: './read.sh',
  ports: ['ticket-source'],
  consumes: { source: value(z.object({ ticketKey: z.string() }).passthrough()) },
  produces: { 'brief.md': 'file', 'others.md': 'file', 'ticket.json': 'file' },
  output: GroomInput,
  exitCodes: { passed: [0], failed: [] },
});

export const readTicket = intake('read-ticket', {
  accepts: ['ticket'],
  output: GroomInput,
  produces: { 'brief.md': 'file', 'others.md': 'file', 'ticket.json': 'file' },
  steps: [read],
});
