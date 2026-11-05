// plan: turns a ticket groom kept into an implementation plan, as create-plan does, so the factory implements it straight
// away. The plan is a document: its template is in place before the session, and its sections and tasks are checked
// after it. What the planner can't settle comes back as at most two open questions, and the plan is then not attached.
import { agent, countItems, doc, file, hasSections, noPlaceholders, value, z } from 'sail';
import { builder, readonly, withTools } from '../../../../lib/permissions';
import { implementWrites } from '../../../../lib/plan-paths';
import { Action, Planned } from '../../schemas';

export const plan = agent('plan', {
  prompt: './prompt.md',
  consumes: { brief: file('brief.md'), report: file('report.md'), actions: value(z.array(Action)) },
  produces: {
    'plan.md': doc('./templates/plan.md', [
      hasSections('Goal', 'Scope', 'Out of Scope', 'Research Summary', 'Decisions', 'Risks', 'Acceptance Criteria'),
      hasSections('Demonstration', 'Tasks', 'Task details'),
      noPlaceholders(),
      countItems('Tasks', { min: 1, as: 'tasks' }),
      implementWrites(builder.write),
    ]),
  },
  output: Planned,
  model: 'deep',
  permissions: withTools(readonly, ['WebFetch']),
  budget: { maxTurns: 80, maxUsd: 3, maxMinutes: 45 },
});
