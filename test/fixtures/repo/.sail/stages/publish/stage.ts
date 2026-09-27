// publish: describes the change, then opens the pull request. Its outcome is the open step's.
import { agent, file, fromStep, script, stage, value, z } from 'sail';
import { TicketInput } from 'sail/intakes';

export const PrDescription = z.object({ title: z.string().max(120), bodyFile: z.string() });

export const PrInfo = z.object({ number: z.number().int(), url: z.string(), draft: z.boolean() });

export const publish = stage('publish', {
  consumes: { ticket: value(TicketInput), spec: file('spec.md') },
  output: PrInfo,
  steps: [
    agent('describe', {
      prompt: './describe.md',
      produces: { 'pr-body.md': 'file' },
      output: PrDescription,
      model: 'default',
      permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git log *', 'git diff *'] },
      budget: { maxTurns: 20, maxUsd: 1, maxMinutes: 5 },
    }),
    script('open', {
      run: './open.sh',
      consumes: { description: fromStep('describe').output() },
      output: PrInfo,
    }),
  ],
});
