// hand-over: a review that stopped on something no run of it can change, such as a stage blocked on a requirement
// the workspace can't meet, leaves the pull request to a human. It comments why, takes the designation label off, so
// the watcher doesn't review it again, and puts NEEDS_HUMAN on. Putting the designation label back reviews it again.
import { script, value, z } from 'sail';
import { PullRequestRef } from '../../../../stages/file-follow-ups/stage';

/** The label a pull request left to a human carries. */
export const NEEDS_HUMAN = 'needs-human';

export const handOver = script('hand-over', {
  run: './run.sh',
  consumes: { pr: value(PullRequestRef), label: value(z.string()), reason: value(z.string()) },
  output: z.object({ handedOver: z.boolean() }),
  exitCodes: { passed: [0], failed: [] },
});
