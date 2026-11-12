// duplicates: ranks the open tickets the intake listed by how likely each describes the same work as the groomed one. It
// asks Jev the same-work question of the groomed ticket against every other, in batches, and names the closest three
// that score 0.05 or more (.sail/lib/duplicates.mjs), each with Jev's score as its confidence. It never judges: the
// workflow applies the threshold to these numbers, and `decide` reads each candidate. When Jev cannot be asked, as with
// no Jev adapter or an answer that is an error, it passes with no candidates and an `unchecked` reason, so no groom run
// fails for want of Jev.
import { file, script } from 'sail';
import { Duplicates } from '../../schemas';

export const duplicates = script('duplicates', {
  run: './run.sh',
  ports: ['jev'],
  consumes: { ticket: file('ticket.json'), others: file('others.json') },
  output: Duplicates,
  exitCodes: { passed: [0], failed: [] },
});
