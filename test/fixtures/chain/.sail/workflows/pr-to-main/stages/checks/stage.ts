// checks: waits for the required checks on the head the branch was pushed at, and gives a verdict. `failed` when any
// check failed, `passed` once every required name has passed and none is pending, `pending` otherwise: an empty read,
// before any check registered, is pending, never passed, and so is a required check that was skipped.
import { script, value, z } from 'sail';

export const CheckRead = z.object({ name: z.string(), status: z.enum(['pending', 'passed', 'failed', 'skipped']) });

export const ChecksRead = z.object({
  verdict: z.enum(['passed', 'failed', 'pending']),
  checks: z.array(CheckRead),
});

/** What a failed read carries back to the fix loop. */
export const ChecksFeedback = z.object({ checks: z.array(CheckRead) });

export const checks = script('checks', {
  run: './run.sh',
  ports: ['codehost'],
  consumes: {
    pr: value(z.number().int()),
    headSha: value(z.string()),
    required: value(z.array(z.string())),
    tries: value(z.number().int()),
    intervalSeconds: value(z.number()),
  },
  output: ChecksRead,
  // The verdict is the output: a read that found a failed or pending check still ends the step.
  exitCodes: { passed: [0], failed: [] },
  timeoutSeconds: 300,
});
