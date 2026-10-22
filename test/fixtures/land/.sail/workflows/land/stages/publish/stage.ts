// publish: commits landed/<ticket>.md, pushes the run's branch and opens its pull request into main, labelled sail.
import { script, value, z } from 'sail';

export const Published = z.object({ number: z.number().int(), url: z.string(), headSha: z.string() });

export const publish = script('publish', {
  run: './run.sh',
  consumes: { ticketKey: value(z.string()) },
  output: Published,
  // A port call that failed is an error, never a verdict: no exit code means failed.
  exitCodes: { passed: [0], failed: [] },
});
