// security: one of review's six reviewers. It reads the change and never writes to it, so it can run beside the others.
import { agent, file, z } from 'sail';

export const security = agent('security', {
  prompt: './prompt.md',
  consumes: { brief: file('brief.md') },
  output: z.object({
    summary: z.string(),
    findings: z.array(
      z.object({
        severity: z.enum(['high', 'medium', 'low', 'nit']),
        file: z.string(),
        title: z.string(),
        detail: z.string(),
      }),
    ),
  }),
  model: 'default',
  permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
  budget: { maxTurns: 10, maxUsd: 1, maxMinutes: 10 },
});
