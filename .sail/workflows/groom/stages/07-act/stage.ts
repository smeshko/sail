// act: attaches the plan when there is one, then comments the judge's report on the ticket, the plan's risk and tasks,
// the open questions it renders from the verdict (each with its options, the recommended one marked) and what was done
// to it, then puts the outcome label on (`groomed`, `open-questions`, or `planned` with `factory`) and takes the
// designation label off last, so the watcher grooms a ticket once. It makes no claim, only the actions it is given (the
// plan is attached and the report posted once per run, and the label swap is tried three times, a second apart): a
// `cancel` moves the ticket to canceled, a `duplicate` relates it as one, which cancels it, and a `merge` rewrites the
// surviving ticket's description and marks each absorbed ticket a duplicate of it. The attached plan.md ends with its
// AttachedPlan trailer, the factory's way back to the plan.
import { file, script, value, z } from 'sail';
import { Acted, Verdict } from '../../schemas';

export const act = script('act', {
  run: './run.sh',
  ports: ['ticket-source'],
  consumes: {
    ticketKey: value(z.string()),
    report: file('report.md'),
    actions: value(Verdict),
    label: value(z.string()),
    plan: file('plan.md').optional(),
  },
  output: Acted,
  // A comment, an attachment or a label that could not be written is an error, never a verdict: no exit code means
  // failed.
  exitCodes: { passed: [0], failed: [] },
});
