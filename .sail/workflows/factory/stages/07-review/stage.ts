// review: one adversarial reviewer of the branch, as a review-plan round runs one. It reports findings with a severity
// and judges nothing: fix triages them, and the workflow numbers them and decides whether another round runs.
import { agent, file, value, z } from 'sail';
import { Finding, History, ReviewLens } from '../../schemas';

export const Reviewed = z.object({ summary: z.string(), findings: z.array(Finding) });

export const review = agent('review', {
  prompt: './prompt.md',
  consumes: { plan: file('plan.md'), lens: value(ReviewLens), history: value(History).optional() },
  output: Reviewed,
  model: 'deep',
  permissions: {
    read: ['**'],
    write: ['$STAGE_OUT/**'],
    commands: ['git log *', 'git diff *', 'git show *', 'git grep *', 'bun run test *', 'bun run typecheck'],
  },
  budget: { maxTurns: 80, maxUsd: 3, maxMinutes: 15 },
});
