// demonstrate: shows the pull request's change working the way a user would see it, in a demo repository on fake
// ports, from the Demonstration section its body carries, or from its requirements when it has none. It reports what
// it saw for each criterion and judges nothing: the judge weighs a criterion it couldn't show.
import { agent, file, value, z } from 'sail';
import { Demonstrated } from '../../schemas';

export const demonstrate = agent('demonstrate', {
  prompt: './prompt.md',
  consumes: { brief: file('brief.md'), requirements: file('requirements.md'), base: value(z.string()) },
  output: Demonstrated,
  model: 'default',
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
      'echo *',
      'cut *',
      'git log *',
      'git diff *',
      'git show *',
      'git grep *',
      '.sail/lib/demo.sh *',
    ],
  },
  budget: { maxTurns: 60, maxUsd: 3, maxMinutes: 15 },
});
