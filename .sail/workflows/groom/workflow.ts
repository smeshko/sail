// groom: a groom-labelled ticket in, one comment out. The ticket is read without a claim, so it stays where it is. Three
// checks look at it at once (duplicates, staleness, open questions); a judge writes the report and chooses actions from
// a fixed set; the act step applies them, comments the report and takes the label off, so the watcher grooms each ticket
// once. Composition only: every contract lives on its stage.
import { workflow, type z } from 'sail';
import { readTicket } from './intake';
import type { Decision, Duplicates, Plan } from './schemas';
import { duplicates } from './stages/01-duplicates/stage';
import { staleness } from './stages/02-staleness/stage';
import { questions } from './stages/03-questions/stage';
import { decide } from './stages/04-decide/stage';
import { act } from './stages/05-act/stage';

/** The designation label: a ticket carrying it is groomed, and the run takes it off. */
const LABEL = 'groom';

/**
 * The confidence the duplicates check must name a ticket at for a `duplicate` action to mark the ticket. A duplicate
 * cancels the ticket, so the judge can ask for it but only this number, which the judge didn't measure, lets it through.
 */
const DUPLICATE_CONFIDENCE = 0.8;

/**
 * Splits the judge's actions into those to apply and those to report. A `duplicate` is applied when the check named its
 * ticket at `DUPLICATE_CONFIDENCE` or more, and only the first such; any other is reported with the reason, as is an
 * `edit` that names nothing to change.
 */
function limit(
  actions: z.infer<typeof Decision>['actions'],
  candidates: z.infer<typeof Duplicates>['candidates'],
): z.infer<typeof Plan> {
  const apply: z.infer<typeof Plan>['apply'] = [];
  const reported: string[] = [];
  for (const action of actions) {
    if (action.kind === 'edit' && action.title === undefined && action.description === undefined) {
      reported.push('edit (names neither a title nor a description)');
      continue;
    }
    if (action.kind !== 'duplicate') {
      apply.push(action);
      continue;
    }
    const named = candidates.find((candidate) => candidate.ticketKey === action.of);
    if (named === undefined) {
      reported.push(`duplicate of ${action.of} (not named by the duplicates check)`);
    } else if (named.confidence < DUPLICATE_CONFIDENCE) {
      reported.push(
        `duplicate of ${action.of} (confidence ${named.confidence.toFixed(2)}, under ${DUPLICATE_CONFIDENCE.toFixed(2)})`,
      );
    } else if (apply.some((each) => each.kind === 'duplicate')) {
      reported.push(
        `duplicate of ${action.of} (confidence ${named.confidence.toFixed(2)}, a duplicate is already marked)`,
      );
    } else {
      apply.push(action);
    }
  }
  return { apply, reported };
}

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
      actions: limit(decided.output.actions, dup.output.candidates),
      label: LABEL,
    });
    return acted.output;
  },
);
