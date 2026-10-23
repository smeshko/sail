// ticket-to-pr, the chain fixture's test version: a ticket in, a pull request out, and nothing but `publish`. It opens
// the pull request labelled for pr-to-main, links it on the ticket and moves the ticket to In Review. Watched every
// 30 s, the floor, one run at once.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { publish } from './stages/publish/stage';

export default workflow(
  'ticket-to-pr',
  { intake: ticket, version: 1, watch: { every: '30s' }, maxConcurrentRuns: 1 },
  async (run) => {
    const pr = await run.stage(publish, { ticketKey: run.input.ticketKey });
    return { pr: pr.output };
  },
);
