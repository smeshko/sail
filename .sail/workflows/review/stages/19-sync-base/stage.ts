// sync-base: merges the pull request's current base into its branch, when the base has moved past it. A conflict
// leaves the merge in progress, with the conflicted paths in its output, for resolve-conflicts to finish.
import { script, value, z } from 'sail';
import { PullRequestRef } from '../../../../stages/file-follow-ups/stage';

export const Synced = z.object({
  /** The base had moved past the branch, and a merge of it began. */
  moved: z.boolean(),
  baseSha: z.string(),
  /** The paths the merge left conflicted: empty when it committed cleanly or there was nothing to merge. */
  conflicts: z.array(z.string()),
});

export const syncBase = script('sync-base', {
  run: './run.sh',
  consumes: { pr: value(PullRequestRef), ticketKey: value(z.string()).optional() },
  output: Synced,
  exitCodes: { passed: [0], failed: [] },
});
