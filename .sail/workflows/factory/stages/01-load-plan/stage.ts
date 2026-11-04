// load-plan: finds the plan groom attached to the ticket and leaves it as plan.md, so the factory implements it with no
// planning of its own. A ticket with no plan fails the step, and the workflow fails the run saying how to plan it.
import { script, value, z } from 'sail';
import { LoadedPlan } from '../../schemas';

export const loadPlan = script('load-plan', {
  run: './run.sh',
  ports: ['ticket-source'],
  consumes: { ticketKey: value(z.string()) },
  produces: { 'plan.md': 'file' },
  output: LoadedPlan,
  // 1 is a ticket with no plan, a verdict; a ticket that can't be read is an error.
  exitCodes: { passed: [0], failed: [1] },
});
