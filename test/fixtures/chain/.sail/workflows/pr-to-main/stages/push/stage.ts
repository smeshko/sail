// push: pushes the branch as it stands, and reports its head sha. A push with nothing new succeeds. One whose commits
// since `since`, the head before `fix`, change a file outside src/ and test/ is refused: `failed`, with those files.
import { script, value, z } from 'sail';

export const Pushed = z.object({ headSha: z.string(), files: z.array(z.string()).optional() });

export const push = script('push', {
  run: './run.sh',
  consumes: { since: value(z.string()) },
  output: Pushed,
  // A refusal exits 1. A port call that failed has no exit code to map: an error.
  exitCodes: { passed: [0], failed: [1] },
});
