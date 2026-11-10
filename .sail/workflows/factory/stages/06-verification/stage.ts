// verification: writes what implement reported for each task that changed no file into the pull request's body, as a
// `## Verification` section before the closing `Closes <ticket key>` line. A script copies the evidence, so no model is
// asked for text the run already holds. The workflow calls it only when a task changed no file.
import { file, script, value, z } from 'sail';

export const VerifiedTasks = z.array(z.object({ id: z.string(), evidence: z.string() })).min(1);

export const verification = script('verification', {
  run: './run.sh',
  consumes: { body: file('pr-body.md'), tasks: value(VerifiedTasks) },
  produces: { 'pr-body.md': 'file' },
  output: z.object({ tasks: z.array(z.string()) }),
  exitCodes: { passed: [0], failed: [] },
});
