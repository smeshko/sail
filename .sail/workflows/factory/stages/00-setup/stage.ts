// setup: installs the workspace's dependencies, which a fresh worktree lacks, so the tests and checks can run.
import { script, z } from 'sail';

export const Installed = z.object({ ok: z.boolean(), tail: z.string() });

export const setup = script('setup', {
  run: './run.sh',
  output: Installed,
  // An install that fails is an error, never a verdict.
  exitCodes: { passed: [0], failed: [] },
  timeoutSeconds: 600,
});
