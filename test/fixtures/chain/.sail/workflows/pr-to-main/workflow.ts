// pr-to-main, the chain fixture's test version: a designated pull request in, a squash merge out, or the pull request
// handed back. One pass of `run.loop('review', { max: 3 })`:
//   1. after a failed pass, `fix` answers its feedback and `push` sends the result, unless a commit of it changed a
//      file outside src/ and test/, which hands back;
//   2. six read-only reviewers read the change at once, unless the head is the one the last pass's clean review saw;
//   3. any `high` finding is must-fix, in code: the pass fails with the findings;
//   4. `update` merges main in when it isn't an ancestor, and pushes; a conflict hands the pull request back;
//   5. `tests`, then `checks`, which waits for the required check on the pushed head; a failure is feedback;
//   6. `gate` reads the pull request again: the label gone stops the run, anything else wrong hands it back;
//   7. `merge` reads the pull request and main once more, and squashes at the head the gate read, then the ticket
//      moves to done; a refusal hands back, or stops when the label is gone. A merge answered pending, or whose answer
//      was lost, is re-read, and goes on to done when the pull request merged.
// A loop asked for a fourth pass halts the run, so a failure on the third pass hands back instead of failing the pass.
// A hand-back comments, swaps `sail` for `sail-blocked`, comments on the ticket and fails the run. A stop, because the
// label was removed, comments and fails the run, and adds no `sail-blocked`. Composition only: every contract lives on
// its stage.
import { workflow } from 'sail';
import { pr } from 'sail/intakes';
import { architecture } from './stages/architecture/stage';
import { checks } from './stages/checks/stage';
import { coverageCheck } from './stages/coverage-check/stage';
import { done } from './stages/done/stage';
import { Feedback, fix } from './stages/fix/stage';
import { gate } from './stages/gate/stage';
import { handBack } from './stages/hand-back/stage';
import { merge } from './stages/merge/stage';
import { performance } from './stages/performance/stage';
import { push } from './stages/push/stage';
import { security } from './stages/security/stage';
import { sideEffects } from './stages/side-effects/stage';
import { stop } from './stages/stop/stage';
import { style } from './stages/style/stage';
import { tests } from './stages/tests/stage';
import { update } from './stages/update/stage';

/** The most passes of the review loop. */
const MAX_PASSES = 3;

export default workflow(
  'pr-to-main',
  { intake: pr, version: 1, watch: { every: '30s' }, maxConcurrentRuns: 3 },
  async (run) => {
    const { number, url, ticketKey } = run.input;
    const brief = run.intake.files['brief.md'];
    const reviewers = [style, architecture, sideEffects, performance, security, coverageCheck];

    /** The designation label is gone: a person took the pull request. Says so, and fails the run. */
    const halt = async () => {
      await run.stage(stop, { pr: number, ticketKey });
      return run.fail('the designation label was removed before the merge');
    };

    /** Hands the pull request back, and fails the run. */
    const giveUp = async (reason: string, details: string) => {
      const handed = await run.stage(handBack, { pr: number, ticketKey, reason, details });
      // The label went during the run: the stage said so as a stop does, and swapped nothing.
      if (!handed.output.labelled) return run.fail('the designation label was removed before the merge');
      return run.fail(`handed back: ${reason}`);
    };

    let pass = 0;
    // The head the last pass ended at, once its review was clean: the next pass reads no code it hasn't seen.
    let reviewed: string | undefined;
    // The head the workspace is at: the run's own to start with, then each push's and each update's.
    let at = run.input.headSha;
    for (const iteration of run.loop('review', { max: MAX_PASSES, feedback: Feedback })) {
      pass++;
      const last = pass === MAX_PASSES;

      let pushed: string | undefined;
      if (iteration.previous !== undefined) {
        const fixed = await run.stage(fix, { brief, feedback: iteration.previous });
        if (fixed.outcome === 'blocked') return run.fail(`fix blocked: ${fixed.reason}`);
        const sent = await run.stage(push, { since: at });
        if (sent.outcome === 'failed') {
          return giveUp(
            'fix changed files outside src/ and test/',
            (sent.output.files ?? []).map((file) => `- ${file}`).join('\n'),
          );
        }
        pushed = sent.output.headSha;
        at = pushed;
      }

      const findings: { severity: string; file: string; title: string; detail: string }[] = [];
      if (reviewed === undefined || pushed !== reviewed) {
        const results = await run.all(reviewers.map((reviewer) => [reviewer, { brief }] as const));
        for (const [index, result] of results.entries()) {
          if (result.outcome === 'blocked') return run.fail(`${reviewers[index]?.name} blocked: ${result.reason}`);
          findings.push(...result.output.findings);
        }
      }
      const mustFix = findings.filter((finding) => finding.severity === 'high');
      if (mustFix.length > 0) {
        const feedback = {
          findings: mustFix.map((finding) => ({ ...finding, severity: 'high' as const })),
        };
        if (last) return giveUp('must-fix findings remain', listFindings(mustFix));
        iteration.fail(feedback);
        continue;
      }

      const updated = await run.stage(update);
      if (updated.outcome === 'failed') {
        return giveUp('conflict with main', (updated.output.files ?? []).map((file) => `- ${file}`).join('\n'));
      }
      const head = updated.output.headSha;
      reviewed = head;
      at = head;

      const tested = await run.stage(tests);
      if (tested.outcome === 'failed') {
        if (last) return giveUp('tests failed', listFailures(tested.output.failures));
        iteration.fail(tested.output);
        continue;
      }

      // A wait the step can't finish, killed at its timeout or broken by the host, hands back like one that ran out.
      const waited = await run.stage(
        checks,
        { pr: number, headSha: head, required: ['test'], tries: 4, intervalSeconds: 1 },
        { onError: 'return' },
      );
      if (waited.outcome === 'error') return giveUp('checks unreadable', waited.reason);
      const read = waited.output;
      const bad = read.checks.filter((check) => check.status !== 'passed' && check.status !== 'skipped');
      if (read.verdict === 'pending') {
        return giveUp('checks still pending', read.checks.length === 0 ? 'no check ran' : listChecks(read.checks));
      }
      if (read.verdict === 'failed') {
        if (last) return giveUp('checks failed', listChecks(bad));
        iteration.fail({ checks: read.checks });
        continue;
      }

      const gated = (await run.stage(gate, { pr: number })).output;
      if (!gated.labelled) return halt();
      if (!gated.open || gated.base !== 'main' || gated.headSha !== head) {
        return giveUp(
          'the pull request changed before the merge',
          `open: ${gated.open}\nbase: ${gated.base}\nhead: ${gated.headSha}\nexpected head: ${head}`,
        );
      }

      const merged = await run.stage(merge, { pr: number, headSha: gated.headSha }, { onError: 'return' });
      if (merged.outcome === 'error') return giveUp('merge failed', merged.reason);
      if (merged.output.labelled === false) return halt();
      if (merged.output.state !== 'merged') return giveUp(`merge ${merged.output.state}`, merged.output.reason ?? '');
      if (ticketKey !== undefined) await run.stage(done, { ticketKey, url, sha: merged.output.sha ?? '' });
      return { merged: merged.output.sha, passes: pass };
    }
    return run.fail('the review loop ended without a merge');
  },
);

/** The findings as a list, one per line. */
function listFindings(findings: readonly { severity: string; file: string; title: string; detail: string }[]): string {
  return findings
    .map((finding) => `- ${finding.severity} ${finding.file}: ${finding.title}. ${finding.detail}`)
    .join('\n');
}

/** The failing tests as a list, one per line. */
function listFailures(failures: readonly { test: string; file: string; message: string }[]): string {
  return failures.map((failure) => `- ${failure.test} (${failure.file}): ${failure.message}`).join('\n');
}

/** The checks as a list, one per line. */
function listChecks(read: readonly { name: string; status: string }[]): string {
  return read.map((check) => `- ${check.name}: ${check.status}`).join('\n');
}
