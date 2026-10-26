// judge: reads every finding of validation, the demonstration and the four reviewers, and decides what each becomes:
// fixed on this pull request, filed as a ticket, or dropped. The workflow routes on its verdicts.
import { agent, file, value } from 'sail';
import { Evidence, Findings, Judgement } from '../../schemas';

export const judge = agent('judge', {
  prompt: './prompt.md',
  consumes: {
    brief: file('brief.md'),
    requirements: file('requirements.md'),
    findings: value(Findings),
    evidence: value(Evidence),
  },
  output: Judgement,
  model: 'deep',
  permissions: {
    read: ['**'],
    write: ['$STAGE_OUT/**'],
    commands: ['cat *', 'grep *', 'head *', 'tail *', 'wc *', 'git log *', 'git diff *', 'git show *', 'git grep *'],
  },
  budget: { maxTurns: 60, maxUsd: 3, maxMinutes: 15 },
});
