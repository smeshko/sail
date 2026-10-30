// publish: commits chain/<ticket>.md, pushes the run's branch, opens its pull request into main labelled sail, links it
// on the ticket and moves the ticket to In Review.
import { script, value, z } from 'sail';

export const Published = z.object({ number: z.number().int(), url: z.string(), headSha: z.string() });

export const publish = script('publish', {
  run: './run.sh',
  ports: ['ticket-source', 'codehost'],
  // A test holds the run in this step through $CHAIN_HOLD.
  env: ['CHAIN_HOLD'],
  consumes: { ticketKey: value(z.string()) },
  output: Published,
  // A port call that failed is an error, never a verdict: no exit code means failed.
  exitCodes: { passed: [0], failed: [] },
  timeoutSeconds: 180,
});
