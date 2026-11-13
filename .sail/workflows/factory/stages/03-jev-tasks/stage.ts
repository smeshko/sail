// jev-tasks: asks Jev whether each task of the plan is implemented on the branch, before check-tasks pays for an agent.
// When every answer is a clear yes and no task lists a test file with no change on the branch, its output carries the
// TasksChecked the agent would have submitted, and the workflow goes on without the agent; otherwise, and when Jev
// can't be asked, `checked` is null and check-tasks runs.
import { file, script, value, z } from 'sail';
import { TasksAsked } from '../../schemas';

export const jevTasks = script('jev-tasks', {
  run: './run.sh',
  ports: ['jev'],
  // verified: the ids of the tasks implement reported with no commit, which Jev can't judge: it isn't asked about them, and
  // the workflow accepts them on implement's evidence.
  consumes: { plan: file('plan.md'), verified: value(z.array(z.string())) },
  output: TasksAsked,
  exitCodes: { passed: [0], failed: [] },
});
