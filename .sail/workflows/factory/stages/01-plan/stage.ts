// plan: turns the brief into an implementation plan, as create-plan does. The plan is a document: its template is in
// place before the session, and its sections and tasks are checked after it.
import { agent, countItems, doc, file, hasSections, noPlaceholders } from 'sail';
import { PlanOutput } from '../../schemas';

export const plan = agent('plan', {
  prompt: './prompt.md',
  consumes: { brief: file('brief.md') },
  produces: {
    'plan.md': doc('./templates/plan.md', [
      hasSections('Goal', 'Scope', 'Out of Scope', 'Research Summary', 'Decisions', 'Risks', 'Acceptance Criteria'),
      hasSections('Demonstration', 'Tasks', 'Task details'),
      noPlaceholders(),
      countItems('Tasks', { min: 1, as: 'tasks' }),
    ]),
  },
  output: PlanOutput,
  model: 'deep',
  permissions: {
    read: ['**'],
    write: ['$STAGE_OUT/**'],
    commands: [
      'cat *',
      'grep *',
      'head *',
      'tail *',
      'wc *',
      'sed -n *',
      'echo *',
      'bun --version',
      'git log *',
      'git diff *',
      'git show *',
      'git grep *',
      'ls *',
    ],
  },
  budget: { maxTurns: 80, maxUsd: 3, maxMinutes: 15 },
});
