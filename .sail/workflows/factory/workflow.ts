// factory: a ticket in, a pull request out, along the plan lifecycle: plan the change, implement it task by task, test
// first, validate it, check every task is implemented, then open the pull request. The follow-ups the run found are
// filed as tickets of their own once the pull request is open. The pull request carries the `factory` label, so the
// review workflow picks it up: the deep review, the demonstration and the merge are its.
// Composition only: every contract lives on its stage, and every check that needs no judgment is a script.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { fileFollowUps } from '../../stages/file-follow-ups/stage';
import { validate } from '../../stages/validate/stage';
import { PassFeedback } from './schemas';
import { plan } from './stages/01-plan/stage';
import { implement } from './stages/02-implement/stage';
import { jevTasks } from './stages/03-jev-tasks/stage';
import { checkTasks } from './stages/04-check-tasks/stage';
import { describe } from './stages/05-describe/stage';
import { open } from './stages/06-open/stage';

const IMPLEMENT_PASSES = 3;

export default workflow(
  'factory',
  {
    intake: ticket,
    version: 7,
    watch: { every: '5m' },
    maxConcurrentRuns: 2,
    description: 'plan, implement test first, validate, check the tasks, pull request, follow-ups',
  },
  async (run) => {
    // create-plan
    const p = await run.stage(plan, { brief: run.intake.files['brief.md'] });
    if (p.outcome === 'blocked') return run.fail(`plan blocked: ${p.reason}`);
    const planFile = p.files['plan.md'];
    const commit = { ticketKey: run.input.ticketKey, slug: p.output.slug, scope: p.output.scope };

    // implement-plan, its final validation, then a surface check that every task is implemented: a failed validation,
    // or a task left out, goes back to implement.
    // A failed last pass would fail the run with the loop exceeded: break instead, so the run fails below, saying why.
    let implemented = false;
    let passes = 0;
    for (const iteration of run.loop('implement', { max: IMPLEMENT_PASSES, feedback: PassFeedback })) {
      passes++;
      const impl = await run.stage(implement, { plan: planFile, commit, feedback: iteration.previous });
      if (impl.outcome === 'blocked') return run.fail(`implement blocked: ${impl.reason}`);
      const v = await run.stage(validate);
      if (v.outcome === 'failed') {
        if (passes === IMPLEMENT_PASSES) break;
        iteration.fail({ validation: v.output, tasks: null });
        continue;
      }
      // Jev first: when it answers every task with a clear yes the agent's session is not paid for.
      const asked = await run.stage(jevTasks, { plan: planFile });
      let tasks = asked.output.checked;
      if (tasks === null) {
        const checked = await run.stage(checkTasks, { plan: planFile, jev: asked.output });
        if (checked.outcome === 'blocked') return run.fail(`check-tasks blocked: ${checked.reason}`);
        tasks = checked.output;
      }
      if (tasks.tasks.some((task) => !task.implemented)) {
        if (passes === IMPLEMENT_PASSES) break;
        iteration.fail({ validation: null, tasks });
        continue;
      }
      implemented = true;
      break;
    }
    if (!implemented) return run.fail(`implement: validation or a task still fails after ${IMPLEMENT_PASSES} passes`);

    // create-pr
    const d = await run.stage(describe, { ticket: run.input, plan: planFile });
    if (d.outcome === 'blocked') return run.fail(`describe blocked: ${d.reason}`);
    const pr = await run.stage(open, {
      title: d.output.title,
      body: d.files['pr-body.md'],
      ticketKey: run.input.ticketKey,
    });

    // What describe found beside the change: each a ticket, listed on the pull request.
    const followUps = d.output.followUps.map((each) => ({ ...each, fromReview: false }));
    if (followUps.length > 0) {
      await run.stage(fileFollowUps, {
        followUps: { followUps },
        pr: pr.output,
        origin: `the factory run on ${run.input.ticketKey}`,
      });
    }
    return { pr: pr.output };
  },
);
