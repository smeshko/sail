// implement: makes the change the spec describes, and fixes what the last pass failed with.
import { agent, file, value, z } from 'sail';
import { Finding } from '../self-review/stage';
import { TestReport } from '../tests/stage';

/** What a failed pass of the fix loop carries back: the failing test report, or the findings that must be fixed. */
export const Feedback = z.union([TestReport, z.object({ findings: z.array(Finding) })]);

export const ChangeSet = z.object({
  commits: z.array(z.object({ sha: z.string().length(40), message: z.string() })),
  files: z.array(z.string()),
  notes: z.string().max(600),
});

export const implement = agent('implement', {
  prompt: './prompt.md',
  consumes: { spec: file('spec.md'), feedback: value(Feedback).optional() },
  produces: { 'diff.patch': 'file' },
  output: ChangeSet,
  model: 'default',
  permissions: {
    read: ['**'],
    write: ['src/**', 'test/**', '$STAGE_OUT/**'],
    commands: ['bun test*', 'git add *', 'git commit *', 'git diff *'],
  },
  budget: { maxTurns: 60, maxUsd: 5, maxMinutes: 20 },
});
