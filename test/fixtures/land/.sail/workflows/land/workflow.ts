// land: a ticket in, a pull request merged. A demonstration of review operations through `sail port` alone: it opens a
// pull request, hands the ticket over for review, reads the pull request's checks, swaps its label and merges it at the
// head it opened. Composition only: every contract lives on its stage.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { checks } from './stages/checks/stage';
import { handOver } from './stages/hand-over/stage';
import { merge } from './stages/merge/stage';
import { publish } from './stages/publish/stage';
import { relabel } from './stages/relabel/stage';

export default workflow('land', { intake: ticket, version: 1 }, async (run) => {
  const { ticketKey } = run.input;
  const pr = (await run.stage(publish, { ticketKey })).output;
  await run.stage(handOver, { ticketKey, url: pr.url });
  const read = (await run.stage(checks, { pr: pr.number, tries: 20, intervalSeconds: 3 })).output;
  if (read.verdict !== 'passed') return run.fail(`checks ${read.verdict}`);
  await run.stage(relabel, { pr: pr.number });
  const merged = (await run.stage(merge, { pr: pr.number, headSha: pr.headSha })).output;
  if (merged.state !== 'merged') return run.fail(`merge ${merged.state}: ${merged.reason ?? ''}`);
  return { pr, merge: merged };
});
