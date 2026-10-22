// checks: reads the pull request's checks until none is pending, or the tries run out, and gives a verdict.
import { script, value, z } from 'sail';

export const ChecksRead = z.object({
  verdict: z.enum(['passed', 'failed', 'pending']),
  checks: z.array(z.object({ name: z.string(), status: z.enum(['pending', 'passed', 'failed', 'skipped']) })),
});

export const checks = script('checks', {
  run: './run.sh',
  consumes: { pr: value(z.number().int()), tries: value(z.number().int()), intervalSeconds: value(z.number()) },
  output: ChecksRead,
  exitCodes: { passed: [0], failed: [] },
  // Twenty tries three seconds apart, with room for the reads themselves.
  timeoutSeconds: 180,
});
