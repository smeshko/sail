// groom: a groom-labelled ticket in, one comment out. The ticket is read without a claim, so it stays where it is. Three
// checks look at it at once (duplicates, staleness, open questions); a judge writes the report and chooses actions from
// a fixed set; the act step applies them, comments the report and takes the label off, so the watcher grooms each ticket
// once. Composition only: every contract lives on its stage.
import { workflow } from 'sail';
import { readTicket } from './intake';
import { duplicates } from './stages/01-duplicates/stage';
import { staleness } from './stages/02-staleness/stage';
import { questions } from './stages/03-questions/stage';
import { decide } from './stages/04-decide/stage';
import { act } from './stages/05-act/stage';

/** The designation label: a ticket carrying it is groomed, and the run takes it off. */
const LABEL = 'groom';

export default workflow(
  'groom',
  {
    intake: readTicket,
    version: 1,
    watch: { every: '15m', label: LABEL },
    // One at a time, so two judgments of duplicates never race each other.
    maxConcurrentRuns: 1,
    description: 'check a ticket for duplicates, staleness and open questions, act within limits, comment a report',
  },
  async (run) => {
    const brief = run.intake.files['brief.md'];
    const others = run.intake.files['others.md'];
    const { ticketKey } = run.input;

    const [dup, stale, open] = await run.all([
      [duplicates, { brief, others }],
      [staleness, { brief, others }],
      [questions, { brief, others }],
    ]);
    if (dup.outcome === 'blocked') return run.fail(`duplicates blocked: ${dup.reason}`);
    if (stale.outcome === 'blocked') return run.fail(`staleness blocked: ${stale.reason}`);
    if (open.outcome === 'blocked') return run.fail(`questions blocked: ${open.reason}`);

    const decided = await run.stage(decide, {
      brief,
      findings: { duplicates: dup.output, staleness: stale.output, questions: open.output },
    });
    if (decided.outcome === 'blocked') return run.fail(`decide blocked: ${decided.reason}`);

    const acted = await run.stage(act, {
      ticketKey,
      report: decided.files['report.md'],
      actions: { apply: decided.output.actions, reported: [] },
      label: LABEL,
    });
    return acted.output;
  },
);
