// jev-tasks: asks Jev whether each task of the plan is implemented on the branch, before check-tasks pays for an agent.
// When every answer is a clear yes its output carries the TasksChecked the agent would have submitted, and the
// workflow goes on without the agent; otherwise, and when Jev can't be asked, `checked` is null and check-tasks runs.
import { file, script } from 'sail';
import { TasksAsked } from '../../schemas';

export const jevTasks = script('jev-tasks', {
  run: './run.sh',
  ports: ['jev'],
  consumes: { plan: file('plan.md') },
  output: TasksAsked,
  exitCodes: { passed: [0], failed: [] },
});
