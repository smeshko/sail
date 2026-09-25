// self-review: reviews the change against the spec. The workflow decides which findings must be fixed.
import { agent, file, z } from 'sail';

export const Finding = z.object({
  severity: z.enum(['high', 'medium', 'low', 'nit']),
  file: z.string(),
  title: z.string(),
  detail: z.string(),
});

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
