// describe: writes the pull request's title and body from the ticket, the plan and the review, as create-pr does.
import { agent, file, value, z } from 'sail';
import { TicketInput } from 'sail/intakes';

export const PrDescription = z.object({ title: z.string().max(120), bodyFile: z.string() });

export const describe = agent('describe', {
  prompt: './prompt.md',
  consumes: { ticket: value(TicketInput), plan: file('plan.md'), review: file('REVIEW.md') },
  produces: { 'pr-body.md': 'file' },
  output: PrDescription,
  model: 'default',
  permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git log *', 'git diff *', 'git show *'] },
  budget: { maxTurns: 30, maxUsd: 1, maxMinutes: 5 },
});
