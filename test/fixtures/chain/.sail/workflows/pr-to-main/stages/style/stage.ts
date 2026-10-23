// style: one of pr-to-main's six reviewers. It reads the change and never writes to it, so it can run beside the others.
import { agent, file, z } from 'sail';
import { Finding } from '../fix/stage';

export const style = agent('style', {
  prompt: './prompt.md',
  consumes: { brief: file('brief.md') },
  produces: { 'review.md': 'file' },
  output: z.object({ summary: z.string(), findings: z.array(Finding) }),
  model: 'default',
  permissions: {
    read: ['**'],
    write: ['$STAGE_OUT/**'],
    commands: ['git diff *', 'git log *', 'git show *'],
  },
  budget: { maxTurns: 20, maxUsd: 1, maxMinutes: 10 },
});
