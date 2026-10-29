// jev-triage: asks Jev once about cited hunks, deciding only clear non-merge-stopping findings.
// Unclear answers and unavailable Jev leave every affected finding to the judge.
import { file, script, value } from 'sail';
import { Findings, Triaged } from '../../schemas';

export const jevTriage = script('jev-triage', {
  run: './run.sh',
  ports: ['jev'],
  consumes: { findings: value(Findings), diff: file('diff.patch') },
  output: Triaged,
  exitCodes: { passed: [0], failed: [] },
});
