// requirements: what the pull request should do, for every reviewer to judge it against: its ticket, fetched through
// `sail port ticket-source get`, or, for a pull request that names none, a note that its description is all there is.
import { script, value, z } from 'sail';

export const Requirements = z.object({ ticketKey: z.string().nullable() });

export const requirements = script('requirements', {
  run: './run.sh',
  ports: ['ticket-source'],
  // The ticket key as plain text, empty for a pull request that names none.
  consumes: { ticketKey: value(z.string()) },
  produces: { 'requirements.md': 'file' },
  output: Requirements,
  exitCodes: { passed: [0], failed: [] },
});
