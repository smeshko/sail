// validate: the plan's final validation. Everything is committed, the tests match their lock with no sticker left, and
// `bun run gate` passes: typecheck, lint, and the tests the branch affects. CI's `verify` runs the full suite with its
// coverage gate on the pull request.
import { script, value } from 'sail';
import { Lock, Validation } from '../../schemas';

export const validate = script('validate', {
  run: './run.sh',
  consumes: { lock: value(Lock) },
  output: Validation,
  timeoutSeconds: 1800,
});
