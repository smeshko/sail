// checker(): one of groom's three agent checks, each a stage of its own with its own prompt and output: what every one of
// them reads, may run and may spend. A checker reads the ticket and the repository and never writes to either. It gets
// AGENTS.md alone as conventions: it judges a ticket and writes nothing in the vocabulary, as decide does. Groom's plan is
// the groom stage that gets the glossary. Each names the model alias it runs on:
// `default` unless it says otherwise.
import { agent, file, type z } from 'sail';
import { readonly } from '../../lib/permissions';

export function checker<const N extends string, O extends z.ZodType>(name: N, output: O, model = 'default') {
  return agent(name, {
    prompt: './prompt.md',
    consumes: { brief: file('brief.md'), others: file('others.md') },
    output,
    model,
    conventions: ['AGENTS.md'],
    permissions: readonly,
    budget: { maxTurns: 40, maxUsd: 1, maxMinutes: 20 },
  });
}
