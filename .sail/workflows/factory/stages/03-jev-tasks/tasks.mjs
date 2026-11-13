// Asks Jev one noul per task of the plan in $INPUT_PLAN that has a commit (not those in $INPUT_VERIFIED), and prints the TasksAsked. Jev unreachable, or an answer
// missing, is not an error: `checked` is null with a note, and check-tasks runs as it would without Jev.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = await import(pathToFileURL(join(dirname(process.env.SAIL_CONFIG), 'lib', 'jev-check.mjs')).href);

const plan = lib.parseTasks(readFileSync(process.env.INPUT_PLAN, 'utf8'));
const verified = new Set(JSON.parse(readFileSync(process.env.INPUT_VERIFIED, 'utf8')));
const tasks = plan.filter((task) => !verified.has(task.id));
const asked = { asked: false, note: '', threshold: lib.CLEAR_YES, answers: [], checked: null };
const accepted = (task) => ({
  id: task.id,
  implemented: true,
  evidence: "no commit: accepted on implement's evidence",
});

if (plan.length === 0) {
  asked.note = 'the plan holds no task details to ask about';
} else if (tasks.length === 0) {
  asked.note = 'every task was reported with no commit: nothing to ask Jev';
  asked.checked = { tasks: plan.map(accepted) };
} else {
  const state = lib.tasksState(tasks);
  const result = lib.askNouls(lib.taskQuestions(tasks), state, process.env.STAGE_OUT);
  const unchanged = lib
    .unchangedTests(state)
    .map((each) => `${each.id} names test files with no change on the branch: ${each.paths.join(', ')}`);
  if (!result.asked) {
    asked.note = [...unchanged, result.note].join('; ');
  } else {
    const ids = tasks.map((task) => task.id);
    asked.asked = true;
    asked.answers = lib.yesses(result.answers, ids);
    if (asked.answers.length < ids.length) asked.note = [...unchanged, 'Jev left a task unanswered'].join('; ');
    else if (unchanged.length > 0) asked.note = unchanged.join('; ');
    else if (lib.clearYes(result.answers, ids)) {
      const commits = lib
        .git(['log', `${lib.BASE}..HEAD`, '--format=%h'])
        .trim()
        .split('\n')
        .filter(Boolean);
      const yes = new Map(asked.answers.map((each) => [each.id, each.yes]));
      asked.checked = {
        tasks: plan.map((task) =>
          yes.has(task.id)
            ? {
                id: task.id,
                implemented: true,
                evidence: `Jev answers yes at ${yes.get(task.id)} (clear from ${lib.CLEAR_YES}); branch commits: ${commits.join(', ') || 'none found'}.`,
              }
            : accepted(task),
        ),
      };
    } else asked.note = [...unchanged, `not every task is a clear yes (from ${lib.CLEAR_YES})`].join('; ');
  }
}
console.log(JSON.stringify(asked));
