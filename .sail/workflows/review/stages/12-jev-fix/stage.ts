// jev-fix: asks Jev whether each finding the fixes target is resolved, before check-fix pays for an agent. When every
// answer is a clear yes its output carries the FixChecked the agent would have submitted (the fixes' regressions are
// left to validation, which runs beside it), and the workflow goes on without the agent; otherwise, and when Jev can't be
// asked, `checked` is null and check-fix runs.
import { script, value, z } from 'sail';
import { Findings, FixAsked, Fixed } from '../../schemas';

export const jevFix = script('jev-fix', {
  run: './run.sh',
  consumes: { findings: value(Findings), fixed: value(Fixed), since: value(z.string()) },
  output: FixAsked,
  exitCodes: { passed: [0], failed: [] },
});
