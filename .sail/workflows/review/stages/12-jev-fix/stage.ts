// jev-fix: asks Jev whether each finding the fixes target is resolved, as a hint for check-fix. check-fix runs on every
// fix pass whatever Jev answers; when Jev can't be asked, the output says why.
import { script, value, z } from 'sail';
import { Findings, FixAsked, Fixed } from '../../schemas';

export const jevFix = script('jev-fix', {
  run: './run.sh',
  ports: ['jev'],
  consumes: { findings: value(Findings), fixed: value(Fixed), since: value(z.string()) },
  output: FixAsked,
  exitCodes: { passed: [0], failed: [] },
});
