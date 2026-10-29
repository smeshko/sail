// review: a factory-labelled pull request in, merged out. Validation, the leak check (including its Jev pass), the
// banned-words check, the demonstration and six reviewers look at it at once; Jev triages clear findings, then a judge
// decides what each finding becomes (fixed here, filed as a ticket, or dropped)
// and which reviews are too thin to trust. Up to three fix passes follow, each checked by Jev with agent fallback and
// fresh validation. Then
// the fixes are pushed, the tickets filed, the demonstration attached to the ticket, the review commented, and the pull
// request merged once its checks pass. Landing it takes what fix passes are left: each merges the base in, an agent
// resolving any conflict, and sends checks still red after a rerun to fix as findings; each is validated and pushed
// before the next try. A review that leaves findings open, one too thin to trust, or a pull request that
// can't land in the passes left, comments why, takes the label off and fails, leaving the pull request to a human; so
// does one a stage blocked, which also puts needs-human on, since no run of it would get further.
// Composition only: every contract lives on its stage, and every check that needs no judgment is a script.
import { type Result, workflow, type z } from 'sail';
import { pr } from 'sail/intakes';
import type { FollowUp } from '../../stages/file-follow-ups/stage';
import { fileFollowUps } from '../../stages/file-follow-ups/stage';
import { redTests, validate } from '../../stages/validate/stage';
import type { FixChecked, Judgement, Lens, NumberedFinding, Reviewed, ReviewRecord, Triaged } from './schemas';
import { FixFeedback } from './schemas';
import { requirements } from './stages/01-requirements/stage';
import { bannedWords } from './stages/02-banned-words/stage';
import { leakCheck } from './stages/03-leak-check/stage';
import { demonstrate } from './stages/04-demonstrate/stage';
import { reviewRequirements } from './stages/05-review-requirements/stage';
import { reviewArchitecture } from './stages/06-review-architecture/stage';
import { reviewBugs } from './stages/07-review-bugs/stage';
import { reviewTests } from './stages/08-review-tests/stage';
import { reviewSecurity } from './stages/09-review-security/stage';
import { reviewConventions } from './stages/10-review-conventions/stage';
import { jevTriage } from './stages/11-jev-triage/stage';
import { judge } from './stages/11-judge/stage';
import { fix } from './stages/12-fix/stage';
import { jevFix } from './stages/12-jev-fix/stage';
import { checkFix } from './stages/13-check-fix/stage';
import { push } from './stages/14-push/stage';
import { attachDemonstration } from './stages/16-attach-demonstration/stage';
import { report } from './stages/17-report/stage';
import { merge } from './stages/18-merge/stage';
import { syncBase } from './stages/19-sync-base/stage';
import { resolveConflicts } from './stages/20-resolve-conflicts/stage';
import { handOver } from './stages/21-hand-over/stage';

/** The designation label: the factory's pull requests carry it, and a review that can't finish takes it off. */
const LABEL = 'factory';

/** The reviewers' lenses, in the order the group calls their stages. */
const LENSES = [
  'requirements',
  'architecture',
  'bugs',
  'tests',
  'security',
  'conventions',
] as const satisfies readonly z.infer<typeof Lens>[];

const FIX_PASSES = 3;

export default workflow(
  'review',
  {
    intake: pr,
    version: 4,
    watch: { every: '5m' },
    // Two pull requests at a time, though each merge moves the base the other is being reviewed against.
    maxConcurrentRuns: 2,
    description:
      'validate, leak-check, banned-words, demonstrate and review six ways at once, judge, fix in rounds, merge',
  },
  async (run) => {
    const brief = run.intake.files['brief.md'];
    const { baseSha: base, headSha: since, ticketKey, number } = run.input;
    const pullRequest = { number, url: run.input.url };
    /** A stage blocked on what no run of this review can change: the pull request goes to a human, and the run fails. */
    const handOff = async (reason: string) => {
      await run.stage(handOver, { pr: pullRequest, label: LABEL, reason });
      return run.fail(reason);
    };

    const req = await run.stage(requirements, { ticketKey: ticketKey ?? '' });
    const reading = { brief, requirements: req.files['requirements.md'], base };

    // Everything that looks at the pull request, at once. The reviewers come last, in LENSES' order.
    const [validated, leaks, banned, shown, ...reviews] = await run.all([
      [validate],
      [leakCheck, { diff: run.intake.files['diff.patch'], base }],
      [bannedWords, { diff: run.intake.files['diff.patch'], base }],
      [demonstrate, reading],
      [reviewRequirements, reading],
      [reviewArchitecture, reading],
      [reviewBugs, reading],
      [reviewTests, reading],
      [reviewSecurity, reading],
      [reviewConventions, reading],
    ]);
    if (shown.outcome === 'blocked') return handOff(`demonstrate blocked: ${shown.reason}`);
    if (validated.outcome === 'failed' && validated.output.baseRed) {
      return run.fail(`staging is red: ${redTests(validated.output)}`);
    }
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
    for (const [index, hit] of leaks.output.hits.entries()) {
      findings.push({
        id: `L${index + 1}`,
        source: 'leak-check',
        severity: 'high',
        file: `${hit.file}:${hit.line}`,
        title:
          hit.kind === 'key'
            ? `A tracker key other than ADW: ${hit.match}`
            : hit.kind === 'jev'
              ? 'Jev reads a line as naming another project'
              : 'A term from the private denylist',
        // Denylist and Jev findings name the line, never its potentially private text.
        detail:
          hit.kind === 'key'
            ? `${hit.file}:${hit.line} adds ${hit.match}. Committed text names only sail and its ADW-<n> issues.`
            : hit.kind === 'jev'
              ? `${hit.file}:${hit.line}: the leak check's Jev pass answers yes at ${hit.yes} (hit from ${leaks.output.jev.threshold}). Committed text names only sail and its ADW-<n> issues.`
              : `${hit.file}:${hit.line} adds a term on the leak denylist. Committed text names only sail and its ADW-<n> issues.`,
      });
    }
    for (const [index, hit] of banned.output.hits.entries()) {
      findings.push({
        id: `B${index + 1}`,
        source: 'banned-words',
        severity: 'medium',
        file: `${hit.file}:${hit.line}`,
        title: `Avoided word "${hit.word}": use ${hit.term}`,
        detail: `${hit.file}:${hit.line} uses "${hit.word}", which CONTEXT.md's ${hit.term} entry lists under _Avoid_. Jev answers yes at ${hit.yes} (hit from ${banned.output.jev.threshold}). Use ${hit.term}.`,
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
    const summaries: ({ lens: (typeof LENSES)[number] } & Pick<z.infer<typeof Reviewed>, 'summary' | 'coverage'>)[] =
      [];
    for (const [index, reviewed] of reviews.entries()) {
      const lens = LENSES[index] ?? 'bugs';
      if (reviewed.outcome === 'blocked') return handOff(`review-${lens} blocked: ${reviewed.reason}`);
      summaries.push({ lens, summary: reviewed.output.summary, coverage: reviewed.output.coverage });
      for (const finding of reviewed.output.findings) {
        findings.push({
          ...finding,
          id: `R${findings.filter((each) => each.id.startsWith('R')).length + 1}`,
          source: lens,
        });
      }
    }

    // The judge decides what each finding becomes, and which reviews it can't trust. It runs with no findings too: a
    // clean review is only as good as what its coverage says it checked.
    const triaged = await run.stage(jevTriage, { findings: { findings }, diff: run.intake.files['diff.patch'] });
    const triage: z.infer<typeof Triaged> = triaged.output;
    const judged = await run.stage(judge, {
      triage,
      brief,
      requirements: reading.requirements,
      findings: { findings },
      evidence: { validation: validated.output, demonstration: shown.output, reviews: summaries },
    });
    if (judged.outcome === 'blocked') return handOff(`judge blocked: ${judged.reason}`);
    const overridden = new Set(judged.output.decisions.map((decision) => decision.finding));
    const judgement: z.infer<typeof Judgement> = {
      ...judged.output,
      decisions: [
        ...triage.decided
          .filter((decision) => !overridden.has(decision.finding))
          .map((decision) => ({ ...decision, ticket: null })),
        ...judged.output.decisions,
      ],
    };
    const decided = new Map(judgement.decisions.map((each) => [each.finding, each]));
    const undecided = findings.filter((finding) => !decided.has(finding.id)).map((finding) => finding.id);
    if (undecided.length > 0) return run.fail(`judge left ${undecided.join(', ')} undecided`);
    let targets = findings.filter((finding) => decided.get(finding.id)?.verdict === 'fix');
    // A low-severity finding is never worth a ticket of its own, whatever the judge chose.
    const tickets: z.infer<typeof FollowUp>[] = [];
    for (const decision of judgement.decisions) {
      const severity = findings.find((finding) => finding.id === decision.finding)?.severity;
      if (decision.verdict === 'ticket' && decision.ticket !== null && severity !== 'low')
        tickets.push({ ...decision.ticket, fromReview: true });
    }
    const { thin } = judgement;

    // Fix, then ask Jev about the targets, falling back to the agent unless all are clear yeses, up to FIX_PASSES passes.
    // Always validate afresh. Open targets, new agent findings at medium or above, and failed validation go to the next pass.
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
        if (fixed.outcome === 'blocked') return handOff(`fix blocked: ${fixed.reason}`);
        // Jev first: when it finds every target resolved with a clear yes, the agent's session is not paid for and
        // validation runs alone, which also stands in for what the fixes broke.
        const asked = await run.stage(jevFix, { findings: { findings: targets }, fixed: fixed.output, since });
        let checked: z.infer<typeof FixChecked>;
        let again: Result<typeof validate>;
        if (asked.output.checked !== null) {
          checked = asked.output.checked;
          again = await run.stage(validate);
        } else {
          const [agent, validated] = await run.all([
            [checkFix, { findings: { findings: targets }, fixed: fixed.output, since, jev: asked.output }],
            [validate],
          ]);
          if (agent.outcome === 'blocked') return handOff(`check-fix blocked: ${agent.reason}`);
          checked = agent.output;
          again = validated;
        }
        if (again.outcome === 'failed' && again.output.baseRed)
          return run.fail(`staging is red: ${redTests(again.output)}`);
        rounds.push({ round, fixed: fixed.output, checked, validated: again.outcome === 'passed' });

        const items = new Map(checked.items.map((each) => [each.finding, each]));
        const unresolved = targets
          .filter((target) => items.get(target.id)?.resolved !== true)
          .map((target) => ({
            finding: target.id,
            detail: items.get(target.id)?.detail ?? 'check-fix did not report it',
          }));
        const fresh = checked.findings
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

    // Push the fixes, file the tickets, put the demonstration on the ticket, comment the review.
    const pushed = await run.stage(push, { since });
    if (tickets.length > 0) {
      await run.stage(fileFollowUps, {
        followUps: { followUps: tickets },
        pr: pullRequest,
        origin: `the review of pull request #${number}`,
      });
    }
    if (ticketKey !== undefined) {
      await run.stage(attachDemonstration, { demonstration: shown.output, ticketKey, pr: pullRequest });
    }
    await run.stage(report, {
      record: {
        findings,
        judgement,
        rounds,
        resolved,
        open,
        thin,
        bannedWordsNote: banned.output.jev.candidates > 0 ? banned.output.jev.note : '',
      },
      pr: pullRequest,
      label: LABEL,
    });
    if (!resolved) return run.fail(`review: ${open.length} still open after ${rounds.length} fix rounds`);
    if (thin.length > 0) {
      return run.fail(`review: ${thin.map((each) => `review-${each.lens}`).join(', ')} too thin to trust`);
    }

    // Merge once the checks on the pushed head pass. A retry takes one of the fix passes the review left: it merges the
    // base in, then red checks go to fix as findings. Each is validated, a failed validation going to fix too, then
    // pushed. Anything a pass can't fix blocks the next merge, which comments it and fails, as the last
    // pass's merge does instead of retrying.
    let passes = rounds.length;
    let headSha = pushed.output.headSha;
    let blocked: string | undefined;
    const landing: string[] = [];
    for (const attempt of run.loop('land', { max: FIX_PASSES - passes + 1 })) {
      const merged = await run.stage(merge, {
        pr: pullRequest,
        headSha,
        label: LABEL,
        lastTry: passes === FIX_PASSES,
        landing,
        ...(blocked === undefined ? {} : { blocked }),
      });
      if (merged.outcome === 'failed') return run.fail(`merge: ${merged.output.reason}`);
      const { retry, failed, rerun } = merged.output;
      if (rerun.length > 0) landing.push(`reran ${rerun.join(', ')} once: still red`);
      if (retry === null) return { merged: merged.output, pushed: pushed.output.pushed, tickets: tickets.length };
      passes++;
      blocked = undefined;
      // Either retry merges the base in first, so a fix for red checks is made on the base it will land on.
      const synced = await run.stage(syncBase, {
        pr: pullRequest,
        ...(ticketKey === undefined ? {} : { ticketKey }),
      });
      // Rejected with the base already in, the merge has nothing a pass can fix.
      if (retry === 'base' && !synced.output.moved) {
        blocked = merged.output.reason;
        continue;
      }
      if (synced.output.conflicts.length > 0) {
        const resolved = await run.stage(resolveConflicts, {
          requirements: reading.requirements,
          synced: synced.output,
        });
        if (resolved.outcome === 'blocked' || resolved.output.commit === null) {
          blocked = `the conflicts with the base in ${synced.output.conflicts.join(', ')} weren't resolved`;
          continue;
        }
        landing.push(`merged the base in, resolving conflicts in ${synced.output.conflicts.join(', ')}`);
      } else if (synced.output.moved) landing.push('merged the base in');
      const targets: z.infer<typeof NumberedFinding>[] =
        retry === 'checks'
          ? failed.map((check, index) => ({
              id: `C${passes}-${index + 1}`,
              source: 'checks' as const,
              severity: 'high' as const,
              file: '',
              title: `Check ${check.name} fails`,
              detail: [check.url ?? '', check.log].filter(Boolean).join('\n\n'),
            }))
          : [];
      // A failed validation, or the failed checks, go to fix in this pass.
      const validated = targets.length === 0 ? await run.stage(validate) : undefined;
      if (validated?.outcome === 'failed') {
        targets.push({
          id: `V${passes}`,
          source: 'validate',
          severity: 'high',
          file: validated.output.uncommitted[0] ?? '',
          title: '`bun run gate` fails',
          detail: validated.output.verify.tail,
        });
      }
      if (targets.length > 0) {
        const fixed = await run.stage(fix, {
          requirements: reading.requirements,
          findings: { findings: targets },
          ticketKey,
          base,
        });
        if (fixed.outcome === 'blocked') {
          blocked = `fix blocked: ${fixed.reason}`;
          continue;
        }
        const commits = fixed.output.fixes.filter((each) => each.commit !== null).length;
        const what =
          retry === 'checks' ? `the failed checks ${failed.map((each) => each.name).join(', ')}` : 'validation';
        landing.push(`fixed ${what} in ${commits} commit${commits === 1 ? '' : 's'}`);
        const again = await run.stage(validate);
        if (again.outcome === 'failed') {
          blocked = `validation failed after the fix: ${again.output.verify.tail.split('\n')[0] ?? ''}`;
          continue;
        }
      }
      headSha = (await run.stage(push, { since: headSha })).output.headSha;
      attempt.fail();
    }
    return run.fail('merge: no fix pass left');
  },
);
