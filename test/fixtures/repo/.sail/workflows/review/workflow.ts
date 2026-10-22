// review: six reviewers read the change at once, each on a concern of its own, and the run returns their summaries in
// the order the group declares them. Composition only: every contract lives on its stage.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { architecture } from './stages/architecture/stage';
import { coverage } from './stages/coverage/stage';
import { performance } from './stages/performance/stage';
import { security } from './stages/security/stage';
import { sideEffects } from './stages/side-effects/stage';
import { style } from './stages/style/stage';

export default workflow('review', { intake: ticket, version: 1 }, async (run) => {
  const brief = run.intake.files['brief.md'];
  const reviewers = [style, architecture, sideEffects, performance, security, coverage];
  const results = await run.all(reviewers.map((reviewer) => [reviewer, { brief }] as const));
  const summaries: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.outcome === 'blocked') return run.fail(`${reviewers[index]?.name} blocked: ${result.reason}`);
    summaries.push(result.output.summary);
  }
  return { summaries };
});
