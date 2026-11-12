// fix: fixes what the judge decided to fix on this pull request, one commit each, test first. A later pass reads what
// check-fix found still open, what the fixes broke, and a failed validation.
import { agent, file, untrusted, value, z } from 'sail';
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
    /** The pull request's description as it stands, for a finding about it: its author's text, so untrusted. */
    description: value(untrusted()),
  },
  output: Fixed,
  // It writes code and commit messages, which carry the vocabulary.
  conventions: ['AGENTS.md', 'CONTEXT.md'],
  model: 'deep',
  permissions: builder,
  budget: { maxTurns: 150, maxUsd: 6, maxMinutes: 90 },
});
