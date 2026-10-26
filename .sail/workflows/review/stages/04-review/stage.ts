// review: one reviewer of the pull request through one lens. Four run at once, beside validation and the
// demonstration. It reports findings with a severity and judges nothing: the judge decides what each becomes.
import { agent, file, value, z } from 'sail';
import { Lens, Reviewed } from '../../schemas';

export const review = agent('review', {
  prompt: './prompt.md',
  consumes: {
    brief: file('brief.md'),
    requirements: file('requirements.md'),
    lens: value(Lens),
    base: value(z.string()),
  },
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
      'git log *',
      'git diff *',
      'git show *',
      'git grep *',
      'bun run test *',
      'bun run typecheck',
    ],
  },
  budget: { maxTurns: 80, maxUsd: 3, maxMinutes: 20 },
});
