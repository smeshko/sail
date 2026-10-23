// tests: reports the repository's tests. The fixture has no code under test, so it passes unless the workspace holds
// chain/tests-fail. The exit code decides the outcome, and the report is the output.
import { script, z } from 'sail';

export const TestReport = z.object({
  ok: z.boolean(),
  total: z.number().int(),
  failed: z.number().int(),
  durationMs: z.number().int(),
  failures: z.array(z.object({ test: z.string(), file: z.string(), message: z.string() })),
});

export const tests = script('tests', {
  run: './run.sh',
  output: TestReport,
  exitCodes: { passed: [0], failed: [1] },
});
