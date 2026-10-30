// gate: reads the pull request once more before the merge: whether it is open, what it is based on, the head it is at
// and whether it still carries the designation label.
import { script, value, z } from 'sail';

export const Gate = z.object({ open: z.boolean(), base: z.string(), headSha: z.string(), labelled: z.boolean() });

export const gate = script('gate', {
  run: './run.sh',
  ports: ['codehost'],
  consumes: { pr: value(z.number().int()) },
  output: Gate,
  // A port call that failed is an error, never a verdict: no exit code means failed.
  exitCodes: { passed: [0], failed: [] },
});
