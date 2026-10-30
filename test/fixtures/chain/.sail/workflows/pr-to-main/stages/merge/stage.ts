// merge: reads the pull request once more, then merges it by squash at the head the gate read, or refuses. A merge
// answered pending, or lost, is re-read, and reported merged when the pull request merged.
import { script, value, z } from 'sail';

export const Merged = z.object({
  state: z.enum(['merged', 'pending', 'refused']),
  sha: z.string().optional(),
  reason: z.string().optional(),
  /** False on a refusal because the designation label is gone: the run stops rather than hand back. */
  labelled: z.boolean().optional(),
});

export const merge = script('merge', {
  run: './run.sh',
  ports: ['codehost'],
  consumes: { pr: value(z.number().int()), headSha: value(z.string()) },
  output: Merged,
  exitCodes: { passed: [0], failed: [] },
});
