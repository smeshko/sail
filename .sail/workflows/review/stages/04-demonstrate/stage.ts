// demonstrate: shows the pull request's change working the way a user would see it, in a demo repository on fake
// ports, from the Demonstration section its body carries, or from its requirements when it has none. It reports what
// it saw for each criterion and judges nothing: the judge weighs a criterion it couldn't show.
import { agent, file, value, z } from 'sail';
import { readonly } from '../../../../lib/permissions';
import { Demonstrated } from '../../schemas';

export const demonstrate = agent('demonstrate', {
  prompt: './prompt.md',
  consumes: { brief: file('brief.md'), requirements: file('requirements.md'), base: value(z.string()) },
  output: Demonstrated,
  model: 'default',
  permissions: readonly,
  budget: { maxTurns: 60, maxUsd: 3, maxMinutes: 40 },
});
