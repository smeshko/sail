// self-review: reviews the change against the spec. The workflow decides which findings must be fixed.
import { agent, file, z } from 'sail';
import { Finding } from '../../../../stages/implement/stage';

export const ReviewOutput = z.object({
  summary: z.string(),
  findings: z.array(Finding),
});

export const selfReview = agent('self-review', {
  prompt: './prompt.md',
  consumes: { spec: file('spec.md') },
  produces: { 'review.md': 'file' },
  output: ReviewOutput,
  model: 'deep',
  permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git log *', 'git diff *'] },
  budget: { maxTurns: 30, maxUsd: 2, maxMinutes: 10 },
});
