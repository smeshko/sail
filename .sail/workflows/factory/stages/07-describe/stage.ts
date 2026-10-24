// describe: writes the pull request's title and body from the ticket, the plan and the review, as create-pr does, and
// names the follow-up work the run found beside the deferred review findings, which the workflow files itself.
import { agent, file, value, z } from 'sail';
import { TicketInput } from 'sail/intakes';
import { FollowUp } from '../../schemas';

export const PrDescription = z.object({
  title: z.string().max(120),
  bodyFile: z.string(),
  /** Work outside this branch the run found, beside the deferred findings: each becomes a ticket. */
  followUps: z.array(FollowUp.omit({ fromReview: true })),
});

export const describe = agent('describe', {
  prompt: './prompt.md',
  consumes: { ticket: value(TicketInput), plan: file('plan.md'), review: file('REVIEW.md') },
  produces: { 'pr-body.md': 'file' },
  output: PrDescription,
  model: 'default',
  permissions: {
    read: ['**'],
    write: ['$STAGE_OUT/**'],
    commands: ['cat *', 'grep *', 'head *', 'tail *', 'wc *', 'git log *', 'git diff *', 'git show *'],
  },
  budget: { maxTurns: 30, maxUsd: 1, maxMinutes: 5 },
});
