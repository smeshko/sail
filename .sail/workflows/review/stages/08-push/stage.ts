// push: pushes the fixes to the pull request's branch, when there are any. Its head moves, so CI runs again on it, and
// merge waits for that run.
import { script, value, z } from 'sail';

export const PushedHead = z.object({ pushed: z.boolean(), headSha: z.string() });

export const push = script('push', {
  run: './run.sh',
  // The head the review began at, as plain text.
  consumes: { since: value(z.string()) },
  output: PushedHead,
  exitCodes: { passed: [0], failed: [] },
});
