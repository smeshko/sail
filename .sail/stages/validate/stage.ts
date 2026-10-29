// validate: everything is committed, and `bun run gate` passes: typecheck, lint, and the tests the branch affects. A
// failing test that passes when run again is flaky and doesn't fail it; one that fails on the base too sets baseRed.
// CI's `verify` runs the full suite with its coverage gate on the pull request. Shared: the factory runs it after
// implement, and review runs it beside its reviewers and after each fix.
import { script, z } from 'sail';

export const Validation = z.object({
  ok: z.boolean(),
  /** Paths left uncommitted. */
  uncommitted: z.array(z.string()),
  /** How `bun run gate` ended. */
  verify: z.object({
    ok: z.boolean(),
    exitCode: z.number().int(),
    tail: z.string(),
    /** Each failing test: the change's, flaky (it passed when its file ran again), or the base's (it fails there). */
    failures: z
      .array(z.object({ test: z.string(), file: z.string(), verdict: z.enum(['change', 'flaky', 'base']) }))
      .optional(),
  }),
  /** Every failing test fails on the base too, or is flaky: staging is red, and no change of the branch fixes it. */
  baseRed: z.boolean().optional(),
});

export const validate = script('validate', {
  run: './run.sh',
  output: Validation,
  // The gate waits its turn behind the other runs' gates on the machine.
  timeoutSeconds: 3600,
});

/** The tests a validation found failing on the base too, for a run's failure reason. */
export function redTests(validation: z.infer<typeof Validation>): string {
  const red = (validation.verify.failures ?? []).filter((each) => each.verdict === 'base');
  return red.map((each) => `${each.file}: ${each.test}`).join('; ');
}
