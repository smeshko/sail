// check-fix: reviews the fixes made since the review began: is each finding they target resolved, and did they break
// anything? It runs beside validation, and judges nothing: the workflow decides whether another fix pass runs.
import { agent, value, z } from 'sail';
import { Findings, FixChecked, Fixed } from '../../schemas';

export const checkFix = agent('check-fix', {
  prompt: './prompt.md',
  consumes: { findings: value(Findings), fixed: value(Fixed), since: value(z.string()) },
  output: FixChecked,
  model: 'deep',
  permissions: {
    read: ['**'],
    write: ['$STAGE_OUT/**'],
    commands: [
      'cat *',
      'grep *',
      'head *',
      'tail *',
      'wc *',
      'ls *',
      'sed -n *',
      'echo *',
      'git log *',
      'git diff *',
      'git show *',
      'git grep *',
      'bun run test *',
      'bun run typecheck',
    ],
  },
  budget: { maxTurns: 60, maxUsd: 3, maxMinutes: 15 },
});
