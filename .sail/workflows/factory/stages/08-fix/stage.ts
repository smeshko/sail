// fix: triages every finding of a review round as fix, defer or reject, then fixes the real ones, one commit each, as
// review-plan's triage and fix loop do.
import { agent, file, value, z } from 'sail';
import { CommitInfo, History, NumberedFinding, Triage } from '../../schemas';

export const RoundFindings = z.object({ round: z.number().int(), findings: z.array(NumberedFinding) });

export const Fixed = z.object({ triage: z.array(Triage) });

export const fix = agent('fix', {
  prompt: './prompt.md',
  consumes: {
    plan: file('plan.md'),
    findings: value(RoundFindings),
    history: value(History).optional(),
    commit: value(CommitInfo),
  },
  output: Fixed,
  model: 'deep',
  permissions: {
    read: ['**'],
    write: ['src/**', 'test/**', 'types/**', 'schemas/**', 'bin/**', 'scripts/**', 'CONTEXT.md', '$STAGE_OUT/**'],
    commands: [
      'cat *',
      'grep *',
      'head *',
      'tail *',
      'wc *',
      'bun run test *',
      'bun run typecheck',
      'bun run lint',
      'bun run fix',
      'bun run types',
      'bun run golden',
      'git add *',
      'git commit *',
      'git diff *',
      'git status *',
      'git log *',
      'git show *',
      'git grep *',
    ],
  },
  budget: { maxTurns: 150, maxUsd: 5, maxMinutes: 30 },
});
