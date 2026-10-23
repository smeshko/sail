// done: the pull request is merged: moves its ticket to done and comments the merge on it.
import { script, value, z } from 'sail';

export const Done = z.object({ ticketKey: z.string(), state: z.object({ type: z.string(), name: z.string() }) });

export const done = script('done', {
  run: './run.sh',
  consumes: { ticketKey: value(z.string()), url: value(z.string()), sha: value(z.string()) },
  output: Done,
  // A port call that failed is an error, never a verdict: no exit code means failed.
  exitCodes: { passed: [0], failed: [] },
});
