// Asks Jev one noul per task of the plan in $INPUT_PLAN, and prints the TasksAsked. Jev unreachable, or an answer
// missing, is not an error: `checked` is null with a note, and check-tasks runs as it would without Jev.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = await import(pathToFileURL(join(dirname(process.env.SAIL_CONFIG), 'lib', 'jev-check.mjs')).href);

const tasks = lib.parseTasks(readFileSync(process.env.INPUT_PLAN, 'utf8'));
const asked = { asked: false, note: '', threshold: lib.CLEAR_YES, answers: [], checked: null };

if (tasks.length === 0) {
  asked.note = 'the plan holds no task details to ask about';
} else {
  const result = lib.askNouls(lib.taskQuestions(tasks), lib.tasksState(tasks), process.env.STAGE_OUT);
  if (!result.asked) {
    asked.note = result.note;
  } else {
    const ids = tasks.map((task) => task.id);
    asked.asked = true;
    asked.answers = lib.yesses(result.answers, ids);
    if (asked.answers.length < ids.length) asked.note = 'Jev left a task unanswered';
    else if (lib.clearYes(result.answers, ids)) {
      const commits = lib
        .git(['log', `${lib.BASE}..HEAD`, '--format=%h'])
        .trim()
        .split('\n')
        .filter(Boolean);
      asked.checked = {
        tasks: asked.answers.map((each) => ({
          id: each.id,
          implemented: true,
          evidence: `Jev answers yes at ${each.yes} (clear from ${lib.CLEAR_YES}); branch commits: ${commits.join(', ') || 'none found'}.`,
        })),
      };
    } else asked.note = `not every task is a clear yes (from ${lib.CLEAR_YES})`;
  }
}
console.log(JSON.stringify(asked));
