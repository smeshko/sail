// validate: the plan's final validation. Everything is committed, and `bun run gate` passes: typecheck, lint, and the
// tests the branch affects. CI's `verify` runs the full suite with its coverage gate on the pull request.
import { script } from 'sail';
import { Validation } from '../../schemas';

export const validate = script('validate', {
  run: './run.sh',
  output: Validation,
  timeoutSeconds: 1800,
});
