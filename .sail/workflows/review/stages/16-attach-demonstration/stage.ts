// attach-demonstration: puts the demonstration on the pull request's ticket: each transcript and screenshot the
// demonstrate stage left, uploaded through `sail port ticket-source attach`, then a comment with each criterion, whether
// it was shown and its evidence. It runs once the review is decided, so an upload that fails is reported, not fatal.
import { script, value, z } from 'sail';
import { PullRequestRef } from '../../../../stages/file-follow-ups/stage';
import { Demonstrated } from '../../schemas';

export const Shared = z.object({
  attached: z.array(z.object({ name: z.string(), url: z.string() })),
  failed: z.array(z.object({ name: z.string(), error: z.string() })),
  commented: z.boolean(),
});

export const attachDemonstration = script('attach-demonstration', {
  run: './run.sh',
  ports: ['ticket-source'],
  consumes: { demonstration: value(Demonstrated), ticketKey: value(z.string()), pr: value(PullRequestRef) },
  output: Shared,
  exitCodes: { passed: [0], failed: [] },
});
