// review: a factory-labelled pull request in, merged out. Validation, the demonstration and four reviewers look at it at
// once; a judge decides what each finding becomes: fixed here, filed as a ticket, or dropped. Up to three fix passes
// follow, each reviewed beside a fresh validation. Then the fixes are pushed, the tickets filed, the review commented,
// and the pull request merged once its checks pass. A review that leaves findings open comments them, takes the label
// off and fails, leaving the pull request to a human.
// Composition only: every contract lives on its stage, and every check that needs no judgment is a script.
import { workflow, type z } from 'sail';
import { pr } from 'sail/intakes';
import type { FollowUp } from '../../stages/file-follow-ups/stage';
import { fileFollowUps } from '../../stages/file-follow-ups/stage';
import { validate } from '../../stages/validate/stage';
import type { Judgement, NumberedFinding, ReviewRecord } from './schemas';
import { FixFeedback } from './schemas';
import { requirements } from './stages/01-requirements/stage';
import { demonstrate } from './stages/03-demonstrate/stage';
import { review } from './stages/04-review/stage';
import { judge } from './stages/05-judge/stage';
import { fix } from './stages/06-fix/stage';
import { checkFix } from './stages/07-check-fix/stage';
import { push } from './stages/08-push/stage';
import { report } from './stages/10-report/stage';
import { merge } from './stages/11-merge/stage';

/** The designation label: the factory's pull requests carry it, and a review that can't finish takes it off. */
const LABEL = 'factory';

const LENSES = ['requirements', 'architecture', 'quality', 'bugs'] as const;

const FIX_PASSES = 3;

export default workflow(
  'review',
  {
    intake: pr,
    version: 1,
    watch: { every: '5m' },
    // One pull request at a time: each merge moves the base the next one is reviewed against.
    maxConcurrentRuns: 1,
    description: 'validate, demonstrate and review at once, judge, fix in rounds, merge',
  },
  async (run) => {
    const brief = run.intake.files['brief.md'];
    const { baseSha: base, headSha: since, ticketKey, number } = run.input;
    const pullRequest = { number, url: run.input.url };

    const req = await run.stage(requirements, { ticketKey: ticketKey ?? '' });
    const reading = { brief, requirements: req.files['requirements.md'], base };

    // Everything that looks at the pull request, at once.
    const [validated, shown, ...reviews] = await run.all([
      [validate],
      [demonstrate, reading],
      [review, { ...reading, lens: LENSES[0] }],
      [review, { ...reading, lens: LENSES[1] }],
      [review, { ...reading, lens: LENSES[2] }],
      [review, { ...reading, lens: LENSES[3] }],
    ]);
    if (shown.outcome === 'blocked') return run.fail(`demonstrate blocked: ${shown.reason}`);
    const findings: z.infer<typeof NumberedFinding>[] = [];
    if (validated.outcome === 'failed') {
      const { uncommitted, verify } = validated.output;
      findings.push({
        id: 'V1',
        source: 'validate',
        severity: 'high',
        file: uncommitted[0] ?? '',
        title: verify.ok ? 'Files left uncommitted' : '`bun run gate` fails',
        detail: [verify.ok ? '' : verify.tail, uncommitted.length > 0 ? `Uncommitted: ${uncommitted.join(', ')}` : '']
          .filter(Boolean)
          .join('\n\n'),
      });
    }
    for (const criterion of shown.output.criteria.filter((each) => !each.shown)) {
      findings.push({
        id: `D${findings.filter((each) => each.source === 'demonstrate').length + 1}`,
        source: 'demonstrate',
        severity: 'high',
        file: '',
        title: `Not shown: ${criterion.criterion}`,
        detail: criterion.evidence,
      });
    }
    const summaries: { lens: (typeof LENSES)[number]; summary: string }[] = [];
    for (const [index, reviewed] of reviews.entries()) {
      const lens = LENSES[index] ?? 'bugs';
      if (reviewed.outcome === 'blocked') return run.fail(`review (${lens}) blocked: ${reviewed.reason}`);
      summaries.push({ lens, summary: reviewed.output.summary });
      for (const finding of reviewed.output.findings) {
        findings.push({
          ...finding,
          id: `R${findings.filter((each) => each.id.startsWith('R')).length + 1}`,
          source: lens,
        });
      }
    }

    // The judge decides what each finding becomes.
    let judgement: z.infer<typeof Judgement> | null = null;
    let targets: z.infer<typeof NumberedFinding>[] = [];
    const tickets: z.infer<typeof FollowUp>[] = [];
    if (findings.length > 0) {
      const judged = await run.stage(judge, {
        brief,
        requirements: reading.requirements,
        findings: { findings },
        evidence: { validation: validated.output, demonstration: shown.output, reviews: summaries },
      });
      if (judged.outcome === 'blocked') return run.fail(`judge blocked: ${judged.reason}`);
      judgement = judged.output;
      const decided = new Map(judgement.decisions.map((each) => [each.finding, each]));
      const undecided = findings.filter((finding) => !decided.has(finding.id)).map((finding) => finding.id);
      if (undecided.length > 0) return run.fail(`judge left ${undecided.join(', ')} undecided`);
      targets = findings.filter((finding) => decided.get(finding.id)?.verdict === 'fix');
      for (const decision of judgement.decisions) {
        if (decision.verdict === 'ticket' && decision.ticket !== null)
          tickets.push({ ...decision.ticket, fromReview: true });
      }
    }

    // Fix, then review the fixes beside a fresh validation, up to FIX_PASSES passes. What is still open, what the fixes
    // broke at medium or above, and a failed validation go to the next pass.
    const rounds: z.infer<typeof ReviewRecord>['rounds'] = [];
    let open: z.infer<typeof ReviewRecord>['open'] = [];
    let resolved = targets.length === 0;
    if (!resolved) {
      for (const iteration of run.loop('fix', { max: FIX_PASSES, feedback: FixFeedback })) {
        const round = rounds.length + 1;
        const fixed = await run.stage(fix, {
          requirements: reading.requirements,
          findings: { findings: targets },
          feedback: iteration.previous,
          ticketKey,
          base,
        });
        if (fixed.outcome === 'blocked') return run.fail(`fix blocked: ${fixed.reason}`);
        const [checked, again] = await run.all([
          [checkFix, { findings: { findings: targets }, fixed: fixed.output, since }],
          [validate],
        ]);
        if (checked.outcome === 'blocked') return run.fail(`check-fix blocked: ${checked.reason}`);
        rounds.push({ round, fixed: fixed.output, checked: checked.output, validated: again.outcome === 'passed' });

        const items = new Map(checked.output.items.map((each) => [each.finding, each]));
        const unresolved = targets
          .filter((target) => items.get(target.id)?.resolved !== true)
          .map((target) => ({
            finding: target.id,
            detail: items.get(target.id)?.detail ?? 'check-fix did not report it',
          }));
        const fresh = checked.output.findings
          .filter((finding) => finding.severity !== 'low')
          .map((finding, index) => ({ ...finding, id: `F${round}-${index + 1}`, source: 'check-fix' as const }));
        open = [
          ...unresolved,
          ...fresh.map((finding) => ({ finding: finding.id, detail: finding.title })),
          ...(again.outcome === 'failed'
            ? [{ finding: 'validate', detail: again.output.verify.tail.split('\n')[0] ?? '' }]
            : []),
        ];
        findings.push(...fresh);
        if (open.length === 0) {
          resolved = true;
          break;
        }
        // A failed last pass would fail the run with the loop exceeded: break instead, so the open findings are
        // pushed and reported below.
        if (round === FIX_PASSES) break;
        targets = [...targets, ...fresh];
        iteration.fail({ open: unresolved, fresh, validation: again.outcome === 'failed' ? again.output : null });
      }
    }

    // Push the fixes, file the tickets, comment the review.
    const pushed = await run.stage(push, { since });
    if (tickets.length > 0) {
      await run.stage(fileFollowUps, {
        followUps: { followUps: tickets },
        pr: pullRequest,
        origin: `the review of pull request #${number}`,
      });
    }
    await run.stage(report, {
      record: { findings, judgement, rounds, resolved, open },
      pr: pullRequest,
      label: LABEL,
    });
    if (!resolved) return run.fail(`review: ${open.length} still open after ${rounds.length} fix rounds`);

    // Merge once the checks on the pushed head pass.
    const merged = await run.stage(merge, { pr: pullRequest, headSha: pushed.output.headSha, label: LABEL });
    if (merged.outcome === 'failed') return run.fail(`merge: ${merged.output.reason}`);
    return { merged: merged.output, pushed: pushed.output.pushed, tickets: tickets.length };
  },
);
