// rulings: asks Jev whether the ticket's `## Rulings` answer every open question the last grooming asked, before the
// workflow pays for the duplicates, worth and questions checks. When they do, its output says `skip` and those checks
// don't run. Every failure to ask (no Jev, an error, an unreadable answer) means the full path: without
// TYPESAFE_API_KEY groom runs as it did before this stage.
import { file, script } from 'sail';
import { Ruled } from '../../schemas';

export const rulings = script('rulings', {
  run: './run.sh',
  ports: ['jev'],
  consumes: { ticket: file('ticket.json') },
  output: Ruled,
  exitCodes: { passed: [0], failed: [] },
});
