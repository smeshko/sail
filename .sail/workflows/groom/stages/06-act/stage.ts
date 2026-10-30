// act: comments the judge's report on the ticket with what was done to it, then puts the outcome label on (`groomed` or
// `open-questions`) and takes the designation label off last, so the watcher grooms a ticket once. It makes no claim,
// only the actions it is given (the label swap is tried three times, a second apart): a `cancel` moves the ticket to canceled, a `duplicate` relates it as one, which cancels
// it, and a `merge` rewrites the surviving ticket's description and marks each absorbed ticket a duplicate of it.
import { file, script, value, z } from 'sail';
import { Acted, Plan } from '../../schemas';

export const act = script('act', {
  run: './run.sh',
  ports: ['ticket-source'],
  consumes: { ticketKey: value(z.string()), report: file('report.md'), actions: value(Plan), label: value(z.string()) },
  output: Acted,
  // A comment or a label that could not be written is an error, never a verdict: no exit code means failed.
  exitCodes: { passed: [0], failed: [] },
});
