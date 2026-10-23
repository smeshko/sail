// update: brings the branch up to date with main, and reports the head it ends at. A conflict is `failed`, with the
// files that conflict.
import { script, z } from 'sail';

export const Updated = z.object({
  state: z.enum(['up-to-date', 'merged', 'conflict']),
  headSha: z.string(),
  files: z.array(z.string()).optional(),
});

export const update = script('update', {
  run: './run.sh',
  output: Updated,
  // A conflict exits 1. Any other failure, a push the host refused among them, has no exit code to map: an error.
  exitCodes: { passed: [0], failed: [1] },
});
