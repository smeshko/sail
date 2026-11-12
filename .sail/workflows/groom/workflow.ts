// groom: a groom-labelled ticket in, one comment out, and for a ticket worth doing, its plan. The ticket is read without
// a claim, so it stays where it is unless groom cancels it, merges it into another, or marks it a duplicate. Two agent
// checks and a Jev ranking look at it (duplicates and worth at once, worth also asking whether it is stale; then open
// questions, only when worth keeps the ticket); a judge writes the report, chooses actions
// from a fixed set and confirms the open questions. A ticket that survives them with none open is planned, as the
// factory's plan stage did, and a plan that leaves no question open is attached to the ticket. Before it is, the overlap
// stage reads the plans of the other open `planned` tickets, and the ticket is blocked by the one whose plan changes a
// file its own plan changes (the plan attached last among several), so the factory implements the two in order rather
// than into pull requests that conflict. The act step applies what
// the workflow lets through, attaches the plan, comments the report, takes the `groom` label off and puts `groomed` (an
// action ended the ticket), `open-questions` (a person must answer, then put `groom` back) or `planned` and `factory` on,
// so the watcher grooms each ticket once and the factory implements the plan. A stage that ends blocked hands the ticket
// to a person instead (the hand-over-ticket stage): the `groom` label comes off and `needs-human` goes on, with the
// state left alone. Composition only: every contract lives on its stage.
import { workflow, type z } from 'sail';
import { handOverTicket } from '../../stages/hand-over-ticket/stage';
import { readTicket } from './intake';
import type { Decision, Findings, Verdict } from './schemas';
import { duplicates } from './stages/01-duplicates/stage';
import { worth } from './stages/02-worth/stage';
import { questions } from './stages/04-questions/stage';
import { decide } from './stages/05-decide/stage';
import { plan } from './stages/06-plan/stage';
import { overlap } from './stages/07-overlap/stage';
import { act } from './stages/08-act/stage';

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
 * The score Jev's ranking in the duplicates check must give that two tickets describe the same work for a `duplicate`
 * action, or a `merge` it alone names, to pass.
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
  const { worth: judged } = context.findings;
  if (context.kept.includes(context.ticketKey)) return 'started or an epic';
  if (judged.stale) return undefined;
  const bar = context.fromReview ? REVIEW_CANCEL : CANCEL;
  if (judged.verdict === 'cancel' && judged.confidence >= bar.cancel) return undefined;
  if (judged.verdict === 'keep' && judged.confidence < bar.keep) return undefined;
  const needed = judged.verdict === 'cancel' ? `under ${bar.cancel.toFixed(2)}` : `at or over ${bar.keep.toFixed(2)}`;
  return `the worth check gave ${judged.verdict} at ${judged.confidence.toFixed(2)}, ${needed}, and the ticket is not stale`;
}

/**
 * Splits the judge's actions into those to apply and those to report, and picks the label the ticket ends with, before
 * any plan: `groomed` once an action ends the ticket, `manual` once the judge rules it a person's work, `open-questions` while the
 * judge confirmed any, and `planned` otherwise, which the planner's own questions can still turn into `open-questions`. A
 * `duplicate`, a `cancel` or a `merge` that absorbs this ticket ends it, and no other of them applies after that; a
 * ticket that survives a merge is never canceled. A `cancel` passes the worth check's numbers as `CANCEL` says, a `merge`
 * as `MERGE_CONFIDENCE` and `DUPLICATE_CONFIDENCE` say,
 * never for a kept ticket, and one `merge` and one `labels` apply per run. An `edit` that names nothing to change is reported. A relation of any kind (`related`, `blocks`, `blocked_by`) is applied only to one of `others`,
 * never to `ticketKey` itself: the judge and the checks read the ticket's text, which can name any key. A planned ticket
 * is also blocked by the open planned ticket whose plan shares a file with its own, which the workflow adds after the
 * plan is written, under the same rule.
 */
function limit(decision: z.infer<typeof Decision>, context: Context): z.infer<typeof Verdict> {
  const { ticketKey, others, kept, findings } = context;
  const apply: z.infer<typeof Verdict>['apply'] = [];
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
    if (action.kind === 'manual') {
      if (ended !== undefined) reported.push(`manual (${ended})`);
      else if (apply.some((each) => each.kind === 'manual')) reported.push('manual (already ruled manual)');
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
  // An ending action wins over a manual ruling applied before it.
  const ruled = ended === undefined && apply.some((each) => each.kind === 'manual');
  if (ended !== undefined && apply.some((each) => each.kind === 'manual')) {
    reported.push(`manual (${ended})`);
    for (let index = apply.length - 1; index >= 0; index--) if (apply[index]?.kind === 'manual') apply.splice(index, 1);
  }
  const questions = ended === undefined && !ruled ? decision.questions : [];
  const outcome =
    ended !== undefined ? 'groomed' : ruled ? 'manual' : questions.length > 0 ? 'open-questions' : 'planned';
  return { apply, reported, questions, outcome, plan: null };
}

export default workflow(
  'groom',
  {
    intake: readTicket,
    version: 4,
    watch: { every: '15m', label: LABEL },
    // One at a time, so two judgments of duplicates or merges never race each other.
    maxConcurrentRuns: 1,
    // A judgment of a ticket needs nothing its prerequisites would deliver, so a blocked ticket is groomed all the same.
    ignorePrerequisites: true,
    description:
      'judge a ticket for worth, staleness, merges, duplicates, labels and open questions, merge, cancel or label it, then plan it for the factory',
  },
  async (run) => {
    const brief = run.intake.files['brief.md'];
    const others = run.intake.files['others.md'];
    const { ticketKey } = run.input;
    const handOff = async (reason: string) => {
      await run.stage(handOverTicket, { ticketKey, label: LABEL, reason, workflow: 'groom', unstart: false });
      return run.fail(reason);
    };

    const [dup, earned] = await run.all([
      [duplicates, { ticket: run.intake.files['ticket.json'], others: run.intake.files['others.json'] }],
      [worth, { brief, others }],
    ]);
    if (earned.outcome === 'blocked') return handOff(`worth blocked: ${earned.reason}`);

    // A ticket worth would cancel needs no questions asked of it: decide sees none.
    let open: z.infer<typeof Findings>['questions'] = { questions: [] };
    if (earned.output.verdict === 'keep') {
      const asked = await run.stage(questions, { brief, others });
      if (asked.outcome === 'blocked') return handOff(`questions blocked: ${asked.reason}`);
      open = asked.output;
    }

    const findings = {
      duplicates: dup.output,
      worth: earned.output,
      questions: open,
    };
    const decided = await run.stage(decide, { brief, others, findings });
    if (decided.outcome === 'blocked') return handOff(`decide blocked: ${decided.reason}`);
    const report = decided.files['report.md'];
    const verdict = limit(decided.output, {
      findings,
      ticketKey,
      others: run.input.others,
      kept: run.input.kept,
      fromReview: run.input.fromReview,
    });
    if (verdict.outcome !== 'planned') {
      const acted = await run.stage(act, { ticketKey, report, actions: verdict, label: LABEL, plan: undefined });
      return acted.output;
    }

    // create-plan, for the ticket as the applied actions leave it. Its questions hold the plan back.
    const planned = await run.stage(plan, { brief, report, actions: verdict.apply });
    if (planned.outcome === 'blocked') return handOff(`plan blocked: ${planned.reason}`);
    const { questions: asked, ...written } = planned.output;
    if (asked.length > 0) {
      const acted = await run.stage(act, {
        ticketKey,
        report,
        actions: { ...verdict, questions: asked, outcome: 'open-questions' },
        label: LABEL,
        plan: undefined,
      });
      return acted.output;
    }

    // The plan is going to be attached: the ticket waits on the open planned ticket whose plan changes the same files.
    const found = await run.stage(overlap, { ticketKey, plan: planned.files['plan.md'] });
    const { blockedBy, why } = found.output;
    const waits =
      blockedBy !== null &&
      blockedBy !== ticketKey &&
      run.input.others.includes(blockedBy) &&
      !verdict.apply.some((each) => each.kind === 'blocked_by' && each.to === blockedBy);
    const apply: z.infer<typeof Verdict>['apply'] = waits
      ? [...verdict.apply, { kind: 'blocked_by', to: blockedBy, ...(why === null ? {} : { why }) }]
      : verdict.apply;
    const acted = await run.stage(act, {
      ticketKey,
      report,
      actions: { ...verdict, apply, plan: written },
      label: LABEL,
      plan: planned.files['plan.md'],
    });
    return acted.output;
  },
);
