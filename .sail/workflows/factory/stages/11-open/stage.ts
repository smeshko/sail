// open: pushes the run's branch and opens the pull request into staging, on the code host the repository configures.
import { file, script, value, z } from 'sail';

export const PrInfo = z.object({ number: z.number().int(), url: z.string(), draft: z.boolean() });

export const open = script('open', {
  run: './run.sh',
  // The title and the ticket key as plain text, so the script reads them with no JSON parser.
  consumes: { title: value(z.string().max(120)), body: file('pr-body.md'), ticketKey: value(z.string()) },
  output: PrInfo,
  // A pull request that could not be opened is an error, never a verdict: no exit code means failed.
  exitCodes: { passed: [0], failed: [] },
});
