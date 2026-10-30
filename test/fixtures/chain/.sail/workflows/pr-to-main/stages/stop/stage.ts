// stop: the designation label was removed before the merge, so a person has taken the pull request. It comments that
// the run didn't merge, on the pull request and on its ticket, and changes no label.
import { script, value, z } from 'sail';

export const Stopped = z.object({ number: z.number().int() });

export const stop = script('stop', {
  run: './run.sh',
  ports: ['ticket-source', 'codehost'],
  consumes: { pr: value(z.number().int()), ticketKey: value(z.string()).optional() },
  output: Stopped,
  // A port call that failed is an error, never a verdict: no exit code means failed.
  exitCodes: { passed: [0], failed: [] },
});
