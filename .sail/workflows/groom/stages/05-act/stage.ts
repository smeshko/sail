// act: comments the judge's report on the ticket with what was done to it, and takes the designation label off last, so
// the watcher grooms a ticket once. It moves nothing: no state update and no claim, only the actions it is given.
import { file, script, value, z } from 'sail';
import { Acted, Plan } from '../../schemas';

export const act = script('act', {
  run: './run.sh',
  consumes: { ticketKey: value(z.string()), report: file('report.md'), actions: value(Plan), label: value(z.string()) },
  output: Acted,
  // A comment or a label that could not be written is an error, never a verdict: no exit code means failed.
  exitCodes: { passed: [0], failed: [] },
});
