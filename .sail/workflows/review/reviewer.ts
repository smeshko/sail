// reviewer(): one of review's six reviewers, each a stage of its own with its own prompt: what every one of them reads,
// may run and may spend, and each names the model alias it runs on. A reviewer reads the change and never writes to it,
// so all six run beside each other.
import { agent, file, value, z } from 'sail';
import { readonly } from '../../lib/permissions';
import { Reviewed } from './schemas';

export function reviewer<const N extends string>(name: N, model: string) {
  return agent(name, {
    prompt: './prompt.md',
    consumes: { brief: file('brief.md'), requirements: file('requirements.md'), base: value(z.string()) },
    output: Reviewed,
    model,
    permissions: readonly,
    budget: { maxTurns: 80, maxUsd: 3, maxMinutes: 45 },
  });
}
