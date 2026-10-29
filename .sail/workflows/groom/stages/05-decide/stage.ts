// decide: reads the four checks and writes the grooming report, and chooses what to do to the ticket from a fixed set:
// merge it with other tickets, cancel it, mark a duplicate, set its labels, relate or block another ticket, or edit its
// title or description; and lists the open questions it confirmed. The workflow limits what it applies; the stage only
// chooses.
import { agent, doc, file, hasSections, noPlaceholders, value } from 'sail';
import { readonly } from '../../../../lib/permissions';
import { Decision, Findings } from '../../schemas';

export const decide = agent('decide', {
  prompt: './prompt.md',
  consumes: { brief: file('brief.md'), others: file('others.md'), findings: value(Findings) },
  produces: {
    'report.md': doc('./templates/report.md', [
      hasSections('Worth', 'Merges', 'Duplicates', 'Staleness', 'Labels', 'Open questions'),
      noPlaceholders(),
    ]),
  },
  output: Decision,
  model: 'deep',
  permissions: readonly,
  budget: { maxTurns: 40, maxUsd: 2, maxMinutes: 20 },
});
