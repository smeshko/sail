// merge: waits for the pull request's checks on the head the review left, then merges it into its base, only while it
// is still at that head; a host still showing an older head of the branch is read again until it catches up. Failed
// checks are rerun once. Checks still red, a head that conflicts with its base, or a merge the host rejects, go back
// to the workflow as a retry, with the failed checks' logs, so a sync with the base and a fix pass can run before the
// next try.
// On the last try those, a head that moves or a merge the host refuses fail the step: it comments why and takes the
// designation label off, so the watcher leaves the pull request to a human.
import { script, value, z } from 'sail';
import { PullRequestRef } from '../../../../stages/file-follow-ups/stage';

/** A failed check, still red after its rerun: its log's tail, for the fix pass. */
export const FailedCheck = z.object({ name: z.string(), url: z.string().nullable(), log: z.string() });

export const Merged = z.object({
  merged: z.boolean(),
  sha: z.string().nullable(),
  reason: z.string(),
  /** What the workflow should do before the next try: fix the failed checks, or sync with the base. Null otherwise. */
  retry: z.enum(['checks', 'base']).nullable(),
  failed: z.array(FailedCheck),
  /** The checks rerun once, by name. */
  rerun: z.array(z.string()),
});

export const merge = script('merge', {
  run: './run.sh',
  consumes: {
    pr: value(PullRequestRef),
    headSha: value(z.string()),
    label: value(z.string()),
    /** No retry is handed back: every failure comments, takes the label off and fails. */
    lastTry: value(z.boolean()),
    /** What the review did to land the pull request, one line each, for the comment. */
    landing: value(z.array(z.string())),
    /** Why not to merge at all: the step fails with it, as the last try does. */
    blocked: value(z.string()).optional(),
  },
  output: Merged,
  // CI's `verify` takes minutes, may queue behind other runs, and a rerun waits for it again.
  timeoutSeconds: 3600,
});
