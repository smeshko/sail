// judge: reads every finding of validation, the leak check, the demonstration and the six reviewers, and decides what
// each becomes: fixed on this pull request, filed as a ticket, or dropped. It names the reviews too thin to trust,
// which stop the merge. The workflow routes on its verdicts.
import { agent, file, value } from 'sail';
import { readonly } from '../../../../lib/permissions';
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
  permissions: readonly,
  budget: { maxTurns: 60, maxUsd: 3, maxMinutes: 15 },
});
