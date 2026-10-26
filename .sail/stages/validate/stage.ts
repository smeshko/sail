// validate: everything is committed, and `bun run gate` passes: typecheck, lint, and the tests the branch affects.
// CI's `verify` runs the full suite with its coverage gate on the pull request. Shared: the factory runs it after
// implement, and review runs it beside its reviewers and after each fix.
import { script, z } from 'sail';

export const Validation = z.object({
  ok: z.boolean(),
  /** Paths left uncommitted. */
  uncommitted: z.array(z.string()),
  /** How `bun run gate` ended. */
  verify: z.object({ ok: z.boolean(), exitCode: z.number().int(), tail: z.string() }),
});

export const validate = script('validate', {
  run: './run.sh',
  output: Validation,
  timeoutSeconds: 1800,
});
