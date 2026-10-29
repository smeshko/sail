// fix: fixes what the judge decided to fix on this pull request, one commit each, test first. A later pass reads what
// check-fix found still open, what the fixes broke, and a failed validation.
import { agent, file, value, z } from 'sail';
import { builder } from '../../../../lib/permissions';
import { Findings, Fixed, FixFeedback } from '../../schemas';

export const fix = agent('fix', {
  prompt: './prompt.md',
  consumes: {
    requirements: file('requirements.md'),
    findings: value(Findings),
    feedback: value(FixFeedback).optional(),
    /** The ticket each commit names, unbound for a pull request with none. */
    ticketKey: value(z.string()).optional(),
    base: value(z.string()),
  },
  output: Fixed,
  model: 'sol',
  permissions: builder,
  budget: { maxTurns: 150, maxUsd: 6, maxMinutes: 90 },
});
