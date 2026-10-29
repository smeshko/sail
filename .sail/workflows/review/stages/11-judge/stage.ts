// judge: reads the findings of validation, the leak check, the demonstration and the six reviewers alongside
// Jev's triage, deciding what it leaves open or overruling a clear decision. It names the reviews too thin to trust,
// which stop the merge. The workflow routes on its verdicts.
import { agent, file, value } from 'sail';
import { readonly } from '../../../../lib/permissions';
import { Evidence, Findings, Judgement, Triaged } from '../../schemas';

export const judge = agent('judge', {
  prompt: './prompt.md',
  consumes: {
    brief: file('brief.md'),
    requirements: file('requirements.md'),
    findings: value(Findings),
    evidence: value(Evidence),
    triage: value(Triaged),
  },
  output: Judgement,
  model: 'deep',
  permissions: readonly,
  budget: { maxTurns: 60, maxUsd: 3, maxMinutes: 40 },
});
