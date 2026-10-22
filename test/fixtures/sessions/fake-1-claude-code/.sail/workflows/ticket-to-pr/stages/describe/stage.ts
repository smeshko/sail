// describe: writes the pull request's title and body, from the ticket and the spec.
import { agent, file, value, z } from 'sail';
import { TicketInput } from 'sail/intakes';

export const PrDescription = z.object({ title: z.string().max(120), bodyFile: z.string() });

export const describe = agent('describe', {
  prompt: './prompt.md',
  consumes: { ticket: value(TicketInput), spec: file('spec.md') },
  produces: { 'pr-body.md': 'file' },
  output: PrDescription,
  model: 'default',
  permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git log *', 'git diff *'] },
  budget: { maxTurns: 20, maxUsd: 1, maxMinutes: 5 },
});
