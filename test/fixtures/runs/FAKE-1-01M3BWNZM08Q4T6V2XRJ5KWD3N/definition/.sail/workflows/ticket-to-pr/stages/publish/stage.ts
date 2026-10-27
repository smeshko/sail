// publish: describes the change, then opens the pull request on the code host the repository configures. Its outcome
// is the open step's, unless describe stops it blocked.
import { agent, file, fromStep, script, stage, value, z } from 'sail';
import { TicketInput } from 'sail/intakes';

export const PrDescription = z.object({ title: z.string().max(120), bodyFile: z.string() });

export const PrInfo = z.object({ number: z.number().int(), url: z.string(), draft: z.boolean() });

/** The ticket key as plain text, so the open step reads it with no JSON parser. One schema, for the stage and its step. */
export const TicketKey = z.string();

const describe = agent('describe', {
  prompt: './describe.md',
  consumes: { ticket: value(TicketInput), spec: file('spec.md') },
  produces: { 'pr-body.md': 'file' },
  output: PrDescription,
  model: 'default',
  permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git log *', 'git diff *'] },
  budget: { maxTurns: 20, maxUsd: 1, maxMinutes: 5 },
});

const open = script('open', {
  run: './open.sh',
  // The title as plain text, and the body describe wrote, both from describe.
  consumes: {
    title: fromStep('describe').output('title'),
    body: fromStep('describe').file('pr-body.md'),
    ticketKey: value(TicketKey),
  },
  output: PrInfo,
  // A pull request that could not be opened is an error, never a verdict: no exit code means failed.
  exitCodes: { passed: [0], failed: [] },
});

export const publish = stage('publish', {
  consumes: { ticket: value(TicketInput), spec: file('spec.md'), ticketKey: value(TicketKey) },
  output: PrInfo,
  steps: [describe, open],
});
