// groom: a groom-labelled ticket in, one comment out. The ticket is read without a claim, so it stays where it is unless
// groom cancels it, merges it into another, or marks it a duplicate. Four agent checks look at it at once (duplicates,
// worth, staleness and open questions); a judge writes the report, chooses actions from a fixed set and confirms the open
// questions; the act step applies what the workflow lets through, comments the report, takes the `groom` label off and
// puts `groomed` or `open-questions` on, so the watcher grooms each ticket once. Composition only: every contract lives
// on its stage.
import { workflow, type z } from 'sail';
import { readTicket } from './intake';
import type { Decision, Findings, Plan } from './schemas';
import { duplicates } from './stages/01-duplicates/stage';
import { worth } from './stages/02-worth/stage';
import { staleness } from './stages/03-staleness/stage';
import { questions } from './stages/04-questions/stage';
import { decide } from './stages/05-decide/stage';
import { act } from './stages/06-act/stage';

/** The designation label: a ticket carrying it is groomed, and the run takes it off. */
const LABEL = 'groom';

/**
 * The worth check's numbers that let a `cancel` through: a `cancel` verdict at `cancel` or more, or a `keep` under
 * `keep`, which is no case for keeping it. A ticket a review filed carries no person's ask, so its bar is lower. The
 * judge can ask for a cancel but only these numbers, which the judge didn't measure, let it through.
 */
const CANCEL = { cancel: 0.6, keep: 0.6 };
const REVIEW_CANCEL = { cancel: 0.5, keep: 0.7 };

/** The confidence the worth check must name another ticket at for a `merge` with it to pass. */
const MERGE_CONFIDENCE = 0.65;

/**
 * The confidence the duplicates check must give that two tickets describe the same work for a `duplicate` action, or a
 * `merge` it alone names, to pass.
 */
const DUPLICATE_CONFIDENCE = 0.8;

/** The most tickets one run merges into another. */
const MAX_ABSORBED = 5;

type Action = z.infer<typeof Decision>['actions'][number];

/** What the workflow knows besides the judge's actions: the checks' findings and the intake's ticket keys. */
interface Context {
  readonly findings: z.infer<typeof Findings>;
  readonly ticketKey: string;
  /** The open tickets the intake listed: the only other ends an action may have. */
  readonly others: readonly string[];
  /** The tickets never canceled or merged away: started ones and epics. */
  readonly kept: readonly string[];
  /** Whether a review filed the ticket, which lowers the bar a cancel must clear. */
  readonly fromReview: boolean;
}

/**
 * Why `key` falls short of a merge with the ticket, or undefined when a check named it high enough: the worth check at
 * `MERGE_CONFIDENCE`, or the duplicates check at `DUPLICATE_CONFIDENCE`.
 */
function shortOfMerge(findings: z.infer<typeof Findings>, key: string): string | undefined {
  const worth = findings.worth.merges.filter((each) => each.ticketKey === key).map((each) => each.confidence);
  const named = findings.duplicates.candidates.filter((each) => each.ticketKey === key).map((each) => each.confidence);
  if (worth.length === 0 && named.length === 0) return `${key} not named by the worth or duplicates check`;
  if (worth.some((each) => each >= MERGE_CONFIDENCE) || named.some((each) => each >= DUPLICATE_CONFIDENCE)) {
    return undefined;
  }
  const said = [
    ...(worth.length > 0 ? [`worth ${Math.max(...worth).toFixed(2)}, under ${MERGE_CONFIDENCE.toFixed(2)}`] : []),
    ...(named.length > 0
      ? [`duplicates ${Math.max(...named).toFixed(2)}, under ${DUPLICATE_CONFIDENCE.toFixed(2)}`]
      : []),
  ];
  return `${key} at ${said.join('; ')}`;
}

/** Why the workflow holds back the merge, or undefined when it lets it through. */
function heldMerge(action: Extract<Action, { kind: 'merge' }>, context: Context): string | undefined {
  const { ticketKey, others, kept, findings } = context;
  const tickets = [action.into, ...action.absorb];
  if (action.absorb.length === 0) return 'absorbs no ticket';
  if (!tickets.includes(ticketKey)) return 'leaves this ticket out';
  if (new Set(tickets).size !== tickets.length) return 'names a ticket twice';
  if (action.absorb.length > MAX_ABSORBED) return `absorbs ${action.absorb.length}, over ${MAX_ABSORBED}`;
  const strangers = tickets.filter((key) => key !== ticketKey && !others.includes(key));
  if (strangers.length > 0) return `${strangers.join(', ')} not an open ticket the intake listed`;
  const held = action.absorb.filter((key) => kept.includes(key));
  if (held.length > 0) return `${held.join(', ')} started or an epic`;
  for (const key of tickets.filter((each) => each !== ticketKey)) {
    const short = shortOfMerge(findings, key);
    if (short !== undefined) return short;
  }
  return undefined;
}

/** Why the workflow holds back the cancel, or undefined when it lets it through. */
function heldCancel(context: Context): string | undefined {
  const { worth: judged, staleness: stale } = context.findings;
  if (context.kept.includes(context.ticketKey)) return 'started or an epic';
  if (stale.stale) return undefined;
  const bar = context.fromReview ? REVIEW_CANCEL : CANCEL;
  if (judged.verdict === 'cancel' && judged.confidence >= bar.cancel) return undefined;
  if (judged.verdict === 'keep' && judged.confidence < bar.keep) return undefined;
  const needed = judged.verdict === 'cancel' ? `under ${bar.cancel.toFixed(2)}` : `at or over ${bar.keep.toFixed(2)}`;
  return `the worth check gave ${judged.verdict} at ${judged.confidence.toFixed(2)}, ${needed}, and the ticket is not stale`;
}

/**
 * Splits the judge's actions into those to apply and those to report, and picks the label the ticket ends with. A
 * `duplicate`, a `cancel` or a `merge` that absorbs this ticket ends it, and no other of them applies after that; a
 * ticket that survives a merge is never canceled. A `cancel` passes the worth check's numbers as `CANCEL` says, a `merge`
 * as `MERGE_CONFIDENCE` and `DUPLICATE_CONFIDENCE` say,
 * never for a kept ticket, and one `merge` and one `labels` apply per run. An `edit` that names nothing to change is reported. A relation of any kind is applied only to one of `others`,
 * never to `ticketKey` itself: the judge and the checks read the ticket's text, which can name any key.
 */
function limit(decision: z.infer<typeof Decision>, context: Context): z.infer<typeof Plan> {
  const { ticketKey, others, kept, findings } = context;
  const apply: z.infer<typeof Plan>['apply'] = [];
  const reported: string[] = [];
  /** Why the ticket is gone once an action ends it. */
  let ended: string | undefined;
  for (const action of decision.actions) {
    if (action.kind === 'edit') {
      if (action.title === undefined && action.description === undefined) {
        reported.push('edit (names neither a title nor a description)');
      } else {
        apply.push(action);
      }
      continue;
    }
    if (action.kind === 'labels') {
      if (apply.some((each) => each.kind === 'labels')) reported.push('labels (the labels are already set)');
      else apply.push(action);
      continue;
    }
    if (action.kind === 'cancel') {
      const survives = apply.some((each) => each.kind === 'merge' && each.into === ticketKey);
      const held = ended ?? (survives ? 'the ticket survives a merge' : heldCancel(context));
      if (held === undefined) {
        apply.push(action);
        ended = 'the ticket is already canceled';
      } else {
        reported.push(`cancel (${held})`);
      }
      continue;
    }
    if (action.kind === 'merge') {
      const what = `merge of ${action.absorb.join(', ')} into ${action.into}`;
      const absorbsThis = action.absorb.includes(ticketKey);
      const held = apply.some((each) => each.kind === 'merge')
        ? 'a merge is already applied'
        : (ended ?? heldMerge(action, context));
      if (held === undefined) {
        apply.push(action);
        if (absorbsThis) ended = 'the ticket is already merged away';
      } else {
        reported.push(`${what} (${held})`);
      }
      continue;
    }
    const other = action.kind === 'duplicate' ? action.of : action.to;
    const what = action.kind === 'duplicate' ? `duplicate of ${other}` : `${action.kind} ${other}`;
    if (other === ticketKey) {
      reported.push(`${what} (this ticket itself)`);
      continue;
    }
    if (!others.includes(other)) {
      reported.push(`${what} (not an open ticket the intake listed)`);
      continue;
    }
    if (action.kind !== 'duplicate') {
      apply.push(action);
      continue;
    }
    const named = findings.duplicates.candidates.find((candidate) => candidate.ticketKey === action.of);
    if (named === undefined) {
      reported.push(`duplicate of ${action.of} (not named by the duplicates check)`);
    } else if (named.confidence < DUPLICATE_CONFIDENCE) {
      reported.push(
        `duplicate of ${action.of} (confidence ${named.confidence.toFixed(2)}, under ${DUPLICATE_CONFIDENCE.toFixed(2)})`,
      );
    } else if (kept.includes(ticketKey)) {
      reported.push(`duplicate of ${action.of} (started or an epic)`);
    } else if (ended !== undefined) {
      const why = apply.some((each) => each.kind === 'duplicate') ? 'a duplicate is already marked' : ended;
      reported.push(`duplicate of ${action.of} (confidence ${named.confidence.toFixed(2)}, ${why})`);
    } else {
      apply.push(action);
      ended = 'the ticket is already marked a duplicate';
    }
  }
  const questions = ended === undefined ? decision.questions : [];
  return { apply, reported, questions, outcome: questions.length > 0 ? 'open-questions' : 'groomed' };
}

export default workflow(
  'groom',
  {
    intake: readTicket,
    version: 1,
    watch: { every: '15m', label: LABEL },
    // One at a time, so two judgments of duplicates or merges never race each other.
    maxConcurrentRuns: 1,
    description:
      'judge a ticket for worth, merges, duplicates, staleness, labels and open questions, then merge, cancel or label it',
  },
  async (run) => {
    const brief = run.intake.files['brief.md'];
    const others = run.intake.files['others.md'];
    const { ticketKey } = run.input;

    const [dup, earned, stale, open] = await run.all([
      [duplicates, { brief, others }],
      [worth, { brief, others }],
      [staleness, { brief, others }],
      [questions, { brief, others }],
    ]);
    if (dup.outcome === 'blocked') return run.fail(`duplicates blocked: ${dup.reason}`);
    if (earned.outcome === 'blocked') return run.fail(`worth blocked: ${earned.reason}`);
    if (stale.outcome === 'blocked') return run.fail(`staleness blocked: ${stale.reason}`);
    if (open.outcome === 'blocked') return run.fail(`questions blocked: ${open.reason}`);

    const findings = {
      duplicates: dup.output,
      worth: earned.output,
      staleness: stale.output,
      questions: open.output,
    };
    const decided = await run.stage(decide, { brief, others, findings });
    if (decided.outcome === 'blocked') return run.fail(`decide blocked: ${decided.reason}`);

    const acted = await run.stage(act, {
      ticketKey,
      report: decided.files['report.md'],
      actions: limit(decided.output, {
        findings,
        ticketKey,
        others: run.input.others,
        kept: run.input.kept,
        fromReview: run.input.fromReview,
      }),
      label: LABEL,
    });
    return acted.output;
  },
);
