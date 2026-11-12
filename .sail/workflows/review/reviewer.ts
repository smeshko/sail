// reviewer(): one of review's five reviewers, each a stage of its own with its own prompt: what every one of them reads,
// may run and may spend, and each names the model alias it runs on and, where the alias costs more, its dollar cap. A reviewer reads the change and never writes to it,
// so all five run beside each other. A reviewer may name its own conventions, which replace the config's list; the others take it.
import { agent, file, value, z } from 'sail';
import { readonly } from '../../lib/permissions';
import { Reviewed } from './schemas';

export function reviewer<const N extends string>(
  name: N,
  model: string,
  options: { maxUsd?: number; conventions?: readonly string[] } = {},
) {
  const { maxUsd = 3, conventions } = options;
  return agent(name, {
    prompt: './prompt.md',
    consumes: { brief: file('brief.md'), requirements: file('requirements.md'), base: value(z.string()) },
    output: Reviewed,
    model,
    permissions: readonly,
    budget: { maxTurns: 80, maxUsd, maxMinutes: 45 },
    ...(conventions === undefined ? {} : { conventions }),
  });
}
