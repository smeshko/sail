// check-tasks: a surface review once validation passes: is every task of the plan implemented on the branch? It reads
// the commits against the plan's task list and judges nothing deeper: the review workflow reviews the pull request.
import { agent, file, value, z } from 'sail';
import { readonly } from '../../../../lib/permissions';
import { TasksAsked, TasksChecked } from '../../schemas';

export const checkTasks = agent('check-tasks', {
  prompt: './prompt.md',
  // jev: what Jev answered before this agent was called, a hint where to look.
  // verified: the ids of the tasks implement reported with no commit, which the workflow accepts on implement's evidence.
  consumes: { plan: file('plan.md'), jev: value(TasksAsked), verified: value(z.array(z.string())) },
  output: TasksChecked,
  model: 'default',
  permissions: readonly,
  budget: { maxTurns: 30, maxUsd: 1, maxMinutes: 20 },
  // It compares commits with the plan's tasks: neither the conventions nor the vocabulary bear on that.
  conventions: [],
});
