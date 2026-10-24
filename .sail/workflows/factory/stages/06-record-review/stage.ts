// record-review: writes REVIEW.md, the review's summary for the pull request, from the rounds the workflow collected.
import { script, value, z } from 'sail';
import { History } from '../../schemas';

export const Recorded = z.object({ rounds: z.number().int(), fixed: z.number().int(), deferred: z.number().int() });

export const recordReview = script('record-review', {
  run: './run.sh',
  consumes: { history: value(History) },
  produces: { 'REVIEW.md': 'file' },
  output: Recorded,
  exitCodes: { passed: [0], failed: [] },
  network: 'none',
});
