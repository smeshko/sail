// check-tasks: a surface review once validation passes: is every task of the plan implemented on the branch? It reads
// the commits against the plan's task list and judges nothing deeper: the review workflow reviews the pull request.
import { agent, file } from 'sail';
import { TasksChecked } from '../../schemas';

export const checkTasks = agent('check-tasks', {
  prompt: './prompt.md',
  consumes: { plan: file('plan.md') },
  output: TasksChecked,
  model: 'default',
  permissions: {
    read: ['**'],
    write: ['$STAGE_OUT/**'],
    commands: ['cat *', 'grep *', 'head *', 'tail *', 'wc *', 'git log *', 'git diff *', 'git show *', 'git grep *'],
  },
  budget: { maxTurns: 30, maxUsd: 1, maxMinutes: 10 },
  // It compares commits with the plan's tasks: neither the conventions nor the vocabulary bear on that.
  conventions: [],
});
