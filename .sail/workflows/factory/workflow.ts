// factory: a planned ticket in, a pull request out, along the plan lifecycle: load the plan groom attached to the ticket,
// implement it task by task, test first, validate it, check every task is implemented, then open the pull request. A
// ticket with no plan attached fails the run before any work: groom plans it. A run that ends because an agent
// blocked, or because no plan is attached, hands its ticket to a person (the hand-over-ticket stage): another run
// would end the same way, so the watcher must not retry it. The follow-ups the run found are
// filed as tickets of their own once the pull request is open. The pull request carries the `factory` label, so the
// review workflow picks it up: the deep review, the demonstration and the merge are its.
// Composition only: every contract lives on its stage, and every check that needs no judgment is a script.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';
import { fileFollowUps } from '../../stages/file-follow-ups/stage';
import { handOverTicket } from '../../stages/hand-over-ticket/stage';
import { redTests, validate } from '../../stages/validate/stage';
import { PassFeedback } from './schemas';
import { loadPlan } from './stages/01-load-plan/stage';
import { implement } from './stages/02-implement/stage';
import { jevTasks } from './stages/03-jev-tasks/stage';
import { checkTasks } from './stages/04-check-tasks/stage';
import { describe } from './stages/05-describe/stage';
import { open } from './stages/06-open/stage';

const IMPLEMENT_PASSES = 3;
const LABEL = 'factory';

export default workflow(
  'factory',
  {
    intake: ticket,
    version: 10,
    watch: { every: '5m' },
    // One at a time: two factory runs beside the reviews load the machine until every gate turns flaky (ADW-444).
    maxConcurrentRuns: 1,
    description: "load groom's plan, implement test first, validate, check the tasks, pull request, follow-ups",
  },
  async (run) => {
    const handOff = async (reason: string) => {
      await run.stage(handOverTicket, {
        ticketKey: run.input.ticketKey,
        label: LABEL,
        reason,
        workflow: 'factory',
        unstart: true,
      });
      return run.fail(reason);
    };
    // The plan groom wrote and attached to the ticket: the factory plans nothing itself.
    const p = await run.stage(loadPlan, { ticketKey: run.input.ticketKey });
    if (p.outcome === 'failed' || p.output.plan === null) return handOff(`no plan: ${p.output.note}`);
    const planFile = p.files['plan.md'];
    const commit = { ticketKey: run.input.ticketKey, slug: p.output.plan.slug, scope: p.output.plan.scope };

    // implement-plan, its final validation, then a surface check that every task is implemented: a failed validation,
    // or a task left out, goes back to implement. Tests failing on the base too end the run: no pass would fix them.
    // A failed last pass would fail the run with the loop exceeded: break instead, so the run fails below, saying why.
    // A task implement reported with no commit changed no file: it counts as implemented on its evidence, decided here
    // in code, whatever the task check answered for it.
    let implemented = false;
    let verified: { id: string; evidence: string }[] = [];
    let passes = 0;
    for (const iteration of run.loop('implement', { max: IMPLEMENT_PASSES, feedback: PassFeedback })) {
      passes++;
      const impl = await run.stage(implement, { plan: planFile, commit, feedback: iteration.previous });
      if (impl.outcome === 'blocked') return handOff(`implement blocked: ${impl.reason}`);
      verified = impl.output.tasks.filter((task) => task.commit === null).map(({ id, evidence }) => ({ id, evidence }));
      const v = await run.stage(validate);
      if (v.outcome === 'failed' && v.output.baseRed) return run.fail(`staging is red: ${redTests(v.output)}`);
      if (v.outcome === 'failed') {
        if (passes === IMPLEMENT_PASSES) break;
        iteration.fail({ validation: v.output, tasks: null });
        continue;
      }
      // Jev first: when it answers every task with a clear yes the agent's session is not paid for.
      const asked = await run.stage(jevTasks, { plan: planFile });
      let tasks = asked.output.checked;
      if (tasks === null) {
        const checked = await run.stage(checkTasks, {
          plan: planFile,
          jev: asked.output,
          verified: verified.map((task) => task.id),
        });
        if (checked.outcome === 'blocked') return handOff(`check-tasks blocked: ${checked.reason}`);
        tasks = checked.output;
      }
      const accepted = new Set(verified.map((task) => task.id));
      tasks = {
        ...tasks,
        tasks: tasks.tasks.map((task) =>
          !task.implemented && accepted.has(task.id)
            ? { ...task, implemented: true, evidence: "no commit: accepted on implement's evidence" }
            : task,
        ),
      };
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
    if (d.outcome === 'blocked') return handOff(`describe blocked: ${d.reason}`);
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
