// merge: waits for the pull request's checks on the head the review left, then merges it into its base, only while it
// is still at that head. Checks that fail, a head that moves or a merge the host refuses fail the step: it comments why
// and takes the designation label off, so the watcher leaves the pull request to a human.
import { script, value, z } from 'sail';
import { PullRequestRef } from '../../../../stages/file-follow-ups/stage';

export const Merged = z.object({ merged: z.boolean(), sha: z.string().nullable(), reason: z.string() });

export const merge = script('merge', {
  run: './run.sh',
  consumes: { pr: value(PullRequestRef), headSha: value(z.string()), label: value(z.string()) },
  output: Merged,
  // CI's `verify` takes minutes, and may queue behind other runs.
  timeoutSeconds: 3600,
});
