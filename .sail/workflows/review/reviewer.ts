// reviewer(): one of review's six reviewers, each a stage of its own with its own prompt: what every one of them reads,
// may run and may spend. A reviewer reads the change and never writes to it, so all six run beside each other.
import { agent, file, value, z } from 'sail';
import { Reviewed } from './schemas';

export function reviewer<const N extends string>(name: N) {
  return agent(name, {
    prompt: './prompt.md',
    consumes: { brief: file('brief.md'), requirements: file('requirements.md'), base: value(z.string()) },
    output: Reviewed,
    model: 'deep',
    permissions: {
      read: ['**'],
      write: ['$STAGE_OUT/**'],
      commands: [
        'cat *',
        'grep *',
        'head *',
        'tail *',
        'wc *',
        'ls *',
        'sed -n *',
        'git log *',
        'git diff *',
        'git show *',
        'git grep *',
        'git blame *',
        'bun run test *',
        'bun run typecheck',
      ],
    },
    budget: { maxTurns: 80, maxUsd: 3, maxMinutes: 20 },
  });
}
