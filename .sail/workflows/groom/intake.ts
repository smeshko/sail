// read-ticket: groom's own intake. The built-in `ticket` intake claims, which moves the ticket to In Progress; this one
// only reads: the ticket, and the team's other open tickets for the duplicate check. brief.md and others.md wrap every
// passage a person wrote as untrusted input, for agents. ticket.json (the ticket as `ticket-source get` returns it) and
// others.json (the other tickets) are unwrapped, for scripts that wrap what they pass on: bind neither to an agent.
import { intake, script, value, z } from 'sail';
import { GroomInput } from './schemas';

const read = script('read', {
  run: './read.sh',
  ports: ['ticket-source'],
  consumes: { source: value(z.object({ ticketKey: z.string() }).passthrough()) },
  produces: { 'brief.md': 'file', 'others.json': 'file', 'others.md': 'file', 'ticket.json': 'file' },
  output: GroomInput,
  exitCodes: { passed: [0], failed: [] },
});

export const readTicket = intake('read-ticket', {
  accepts: ['ticket'],
  output: GroomInput,
  produces: { 'brief.md': 'file', 'others.json': 'file', 'others.md': 'file', 'ticket.json': 'file' },
  steps: [read],
});
