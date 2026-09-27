// ticket-to-pr: a ticket in, a pull request out. Composition only: every contract lives on its stage.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { Feedback, implement } from '../stages/implement/stage';
import { publish } from '../stages/publish/stage';
import { selfReview } from '../stages/self-review/stage';
import { spec } from '../stages/spec/stage';
import { tests } from '../stages/tests/stage';

export default workflow(
  'ticket-to-pr',
  { intake: ticket, version: 1, watch: { every: '5m' }, maxConcurrentRuns: 2 },
  async (run) => {
    const s = await run.stage(spec, { brief: run.intake.files['brief.md'] });
    if (s.outcome === 'blocked') return run.fail(`spec blocked: ${s.reason}`);

    // Failing tests, then must-fix findings, go back to implement as the next pass's feedback.
    for (const iteration of run.loop('fix', { max: 3, feedback: Feedback })) {
      const impl = await run.stage(implement, { spec: s.files['spec.md'], feedback: iteration.previous });
      if (impl.outcome === 'blocked') return run.fail(`implement blocked: ${impl.reason}`);
      const t = await run.stage(tests);
      if (t.outcome === 'failed') {
        iteration.fail(t.output);
        continue;
      }
      const r = await run.stage(selfReview, { spec: s.files['spec.md'] });
      if (r.outcome === 'blocked') return run.fail(`self-review blocked: ${r.reason}`);
      const findings = r.output.findings.filter((finding) => finding.severity === 'high');
      if (findings.length === 0) break;
      iteration.fail({ findings });
    }

    return run.stage(publish, { ticket: run.input, spec: s.files['spec.md'] });
  },
);
