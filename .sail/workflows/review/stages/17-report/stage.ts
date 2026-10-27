// report: comments the review on the pull request: the judge's summary, each finding and its verdict, the fix rounds,
// and what is still open. A review that left findings open, or one too thin to trust, also takes the designation label
// off, so the watcher doesn't review the pushed head again.
import { script, value, z } from 'sail';
import { PullRequestRef } from '../../../../stages/file-follow-ups/stage';
import { ReviewRecord } from '../../schemas';

export const report = script('report', {
  run: './run.sh',
  consumes: { record: value(ReviewRecord), pr: value(PullRequestRef), label: value(z.string()) },
  produces: { 'REVIEW.md': 'file' },
  output: z.object({ unlabelled: z.boolean() }),
  exitCodes: { passed: [0], failed: [] },
});
