// factory: a ticket in, a pull request out, along the plan lifecycle: plan the change, implement it task by task, test
// first, validate, then review adversarially in rounds before the pull request. The follow-ups the run found are filed
// as tickets of their own once the pull request is open.
// Composition only: every contract lives on its stage, and every check that needs no judgment is a script.
import { workflow, type z } from 'sail';
import { ticket } from 'sail/intakes';
import type { FollowUp, NumberedFinding, Round } from './schemas';
import { Validation } from './schemas';
import { setup } from './stages/00-setup/stage';
import { plan } from './stages/01-plan/stage';
import { implement } from './stages/02-implement/stage';
import { validate } from './stages/03-validate/stage';
import { review } from './stages/04-review/stage';
import { fix } from './stages/05-fix/stage';
import { recordReview } from './stages/06-record-review/stage';
import { describe } from './stages/07-describe/stage';
import { open } from './stages/08-open/stage';
import { fileFollowUps } from './stages/09-file-follow-ups/stage';

export default workflow(
  'factory',
  { intake: ticket, version: 2, description: 'plan, implement test first, review, pull request, follow-ups' },
  async (run) => {
    await run.stage(setup);

    // create-plan
    const p = await run.stage(plan, { brief: run.intake.files['brief.md'] });
    if (p.outcome === 'blocked') return run.fail(`plan blocked: ${p.reason}`);
    const planFile = p.files['plan.md'];
    const commit = { ticketKey: run.input.ticketKey, slug: p.output.slug, scope: p.output.scope };

    // implement-plan, and its final validation: a failed validation goes back to implement.
    let validated = false;
    for (const iteration of run.loop('implement', { max: 3, feedback: Validation })) {
      const impl = await run.stage(implement, { plan: planFile, commit, feedback: iteration.previous });
      if (impl.outcome === 'blocked') return run.fail(`implement blocked: ${impl.reason}`);
      const v = await run.stage(validate);
      if (v.outcome === 'failed') {
        iteration.fail(v.output);
        continue;
      }
      validated = true;
      break;
    }
    if (!validated) return run.fail('implement: validation still fails after three passes');

    // review-plan: rounds until one fixes nothing, capped by risk. A large or high risk plan gets two lenses in round 1.
    const cap = p.output.risk === 'tiny' || p.output.risk === 'small' ? 2 : 3;
    const twoLenses = p.output.risk === 'large' || p.output.risk === 'high';
    const rounds: z.infer<typeof Round>[] = [];
    for (const iteration of run.loop('review', { max: cap })) {
      const n = rounds.length + 1;
      const history = rounds.length === 0 ? undefined : { rounds };
      const lenses = n === 1 && twoLenses ? (['bugs', 'tests'] as const) : (['all'] as const);
      const reviews = await run.all(lenses.map((lens) => [review, { plan: planFile, lens, history }] as const));
      const findings: z.infer<typeof NumberedFinding>[] = [];
      for (const reviewed of reviews) {
        if (reviewed.outcome === 'blocked') return run.fail(`review blocked: ${reviewed.reason}`);
        for (const finding of reviewed.output.findings)
          findings.push({ ...finding, id: `R${n}-${findings.length + 1}` });
      }
      if (findings.length === 0) {
        rounds.push({ round: n, findings, triage: [] });
        break;
      }
      const fixed = await run.stage(fix, { plan: planFile, findings: { round: n, findings }, history, commit });
      if (fixed.outcome === 'blocked') return run.fail(`fix blocked: ${fixed.reason}`);
      rounds.push({ round: n, findings, triage: [...fixed.output.triage] });
      if (!fixed.output.triage.some((each) => each.verdict === 'fix')) break;
      iteration.fail();
    }
    if (rounds.some((round) => round.triage.some((each) => each.verdict === 'fix'))) {
      const v = await run.stage(validate);
      if (v.outcome === 'failed') return run.fail(`validate after review: ${v.output.verify.tail}`);
    }
    const recorded = await run.stage(recordReview, { history: { rounds } });

    // create-pr
    const d = await run.stage(describe, {
      ticket: run.input,
      plan: planFile,
      review: recorded.files['REVIEW.md'],
    });
    if (d.outcome === 'blocked') return run.fail(`describe blocked: ${d.reason}`);
    const pr = await run.stage(open, {
      title: d.output.title,
      body: d.files['pr-body.md'],
      ticketKey: run.input.ticketKey,
    });

    // The deferred findings, then what describe found beside them: each a ticket, listed on the pull request.
    const deferred: z.infer<typeof FollowUp>[] = rounds.flatMap((round) =>
      round.triage.flatMap((each) => {
        const finding = round.findings.find((one) => one.id === each.finding);
        if (each.verdict !== 'defer' || finding === undefined) return [];
        const description = `${finding.detail}\n\nDeferred in review (${finding.id}, ${finding.severity}, \`${finding.file}\`): ${each.rationale}`;
        return [{ title: finding.title, description, type: 'bug', fromReview: true }];
      }),
    );
    const followUps = [...deferred, ...d.output.followUps.map((each) => ({ ...each, fromReview: false }))];
    if (followUps.length > 0) {
      await run.stage(fileFollowUps, { followUps: { followUps }, pr: pr.output, ticketKey: run.input.ticketKey });
    }
    return { pr: pr.output };
  },
);
