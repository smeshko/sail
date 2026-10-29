// check-fix: reviews the fixes made since the review began: is each finding they target resolved, and did they break
// anything? It runs beside validation, and judges nothing: the workflow decides whether another fix pass runs.
import { agent, value, z } from 'sail';
import { readonly } from '../../../../lib/permissions';
import { Findings, FixAsked, FixChecked, Fixed } from '../../schemas';

export const checkFix = agent('check-fix', {
  prompt: './prompt.md',
  // jev: what Jev answered about each finding before this agent was called, a hint where to look.
  consumes: { findings: value(Findings), fixed: value(Fixed), since: value(z.string()), jev: value(FixAsked) },
  output: FixChecked,
  model: 'deep',
  permissions: readonly,
  budget: { maxTurns: 60, maxUsd: 3, maxMinutes: 30 },
});
