// spec: turns the brief into a spec, with the tasks implement works through.
import { agent, file, z } from 'sail';

export const SpecOutput = z.object({
  summary: z.string().max(400),
  tasks: z.array(z.object({ title: z.string(), files: z.array(z.string()) })).min(1),
});

export const spec = agent('spec', {
  prompt: './prompt.md',
  consumes: { brief: file('brief.md') },
  produces: { 'spec.md': 'file' },
  output: SpecOutput,
  model: 'deep',
  permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git log *', 'git diff *'] },
  budget: { maxTurns: 40, maxUsd: 2, maxMinutes: 10 },
});
