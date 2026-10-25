// demonstrate: shows the change working the way a user would see it, as the plan's Demonstration section says, in a
// demo repository on fake ports. It reports what it saw for each criterion and judges nothing: the workflow sends a
// change it couldn't show back to implement.
import { agent, file, value } from 'sail';
import { Demonstrated, Surface } from '../../schemas';

export const demonstrate = agent('demonstrate', {
  prompt: './prompt.md',
  consumes: { plan: file('plan.md'), surface: value(Surface) },
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
      'git log *',
      'git diff *',
      'git show *',
      'git grep *',
      '.sail/lib/demo.sh *',
    ],
  },
  budget: { maxTurns: 60, maxUsd: 3, maxMinutes: 15 },
});
