// tests: runs the repository's tests. The exit code decides the outcome, and the report is the output.
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
  produces: { 'junit.xml': 'file' },
  output: TestReport,
  exitCodes: { passed: [0], failed: [1] },
});
