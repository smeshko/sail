// fix: changes the branch to answer what the last pass failed with: must-fix findings, a failed test report or failed
// checks. It commits its change; the `push` stage sends it. The schemas the reviewers and the workflow share live here.
import { agent, file, value, z } from 'sail';
import { ChecksFeedback } from '../checks/stage';
import { TestReport } from '../tests/stage';

/** One thing a review found in the change. */
export const Finding = z.object({
  severity: z.enum(['high', 'medium', 'low', 'nit']),
  file: z.string(),
  title: z.string(),
  detail: z.string(),
});

/** What a failed pass carries back: must-fix findings, the failing test report, or the checks that failed. */
export const Feedback = z.union([TestReport, z.object({ findings: z.array(Finding) }), ChecksFeedback]);

export const ChangeSet = z.object({
  commits: z.array(z.object({ sha: z.string().length(40), message: z.string() })),
  files: z.array(z.string()),
  notes: z.string().max(600),
});

export const fix = agent('fix', {
  prompt: './prompt.md',
  consumes: { brief: file('brief.md'), feedback: value(Feedback).optional() },
  output: ChangeSet,
  model: 'default',
  permissions: {
    read: ['**'],
    write: ['src/**', 'test/**', '$STAGE_OUT/**'],
    commands: ['bun test*', 'git add *', 'git commit *', 'git diff *'],
  },
  budget: { maxTurns: 40, maxUsd: 3, maxMinutes: 20 },
});
