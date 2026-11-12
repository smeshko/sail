// overlap: finds the open ticket the newly planned one must wait on, so two plans that change the same file are never
// implemented side by side into pull requests that conflict. It reads the plan attached last to every other open ticket
// labelled `planned` and compares the paths its tasks name with the new plan's (.sail/lib/overlap.mjs). Of the tickets
// that share a path it names one: the one whose plan was attached last, passing over any that already waits on this
// ticket. It writes nothing to a ticket: the workflow turns its answer into a `blocked_by` action, which act applies.
import { file, script, value, z } from 'sail';
import { Overlap } from '../../schemas';

export const overlap = script('overlap', {
  run: './run.sh',
  ports: ['ticket-source'],
  consumes: { ticketKey: value(z.string()), plan: file('plan.md') },
  output: Overlap,
  // A list, a download or a ticket that could not be read is an error, never a verdict: no exit code means failed.
  exitCodes: { passed: [0], failed: [] },
});
