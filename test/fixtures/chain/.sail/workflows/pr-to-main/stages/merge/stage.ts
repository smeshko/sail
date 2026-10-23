// merge: merges the pull request by squash, at the head the gate read.
import { script, value, z } from 'sail';

export const Merged = z.object({
  state: z.enum(['merged', 'pending', 'refused']),
  sha: z.string().optional(),
  reason: z.string().optional(),
});

export const merge = script('merge', {
  run: './run.sh',
  consumes: { pr: value(z.number().int()), headSha: value(z.string()) },
  output: Merged,
  exitCodes: { passed: [0], failed: [] },
});
