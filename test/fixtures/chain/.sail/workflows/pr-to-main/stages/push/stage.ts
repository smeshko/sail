// push: pushes the branch as it stands, and reports its head sha. A push with nothing new succeeds.
import { script, z } from 'sail';

export const Pushed = z.object({ headSha: z.string() });

export const push = script('push', {
  run: './run.sh',
  output: Pushed,
  // A port call that failed is an error, never a verdict: no exit code means failed.
  exitCodes: { passed: [0], failed: [] },
});
