// decide: reads the three checks and writes the grooming report, and chooses what to do to the ticket from a fixed set:
// mark a duplicate, relate or block another ticket, or edit its title or description. The workflow limits what it
// applies; the stage only chooses.
import { agent, doc, file, hasSections, noPlaceholders, value } from 'sail';
import { Decision, Findings } from '../../schemas';

export const decide = agent('decide', {
  prompt: './prompt.md',
  consumes: { brief: file('brief.md'), findings: value(Findings) },
  produces: {
    'report.md': doc('./templates/report.md', [
      hasSections('Duplicates', 'Staleness', 'Open questions'),
      noPlaceholders(),
    ]),
  },
  output: Decision,
  model: 'deep',
  permissions: {
    read: ['**'],
    write: ['$STAGE_OUT/**'],
    commands: ['cat *', 'grep *', 'head *', 'tail *', 'wc *', 'ls *', 'sed -n *', 'echo *', 'git log *', 'git grep *'],
  },
  budget: { maxTurns: 40, maxUsd: 2, maxMinutes: 10 },
});
