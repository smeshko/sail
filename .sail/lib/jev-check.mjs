// What the jev-tasks and jev-fix stages share: ask Jev whether each item of a set is done, and read its answers. A
// stage that finds every answer a clear yes hands the agent's job to Jev; anything else, Jev unreachable included, is
// the agent's. The state builders live here too, so the agreement script asks Jev exactly what the stages do.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The probability of yes at or above which an answer is clear. Conservative until the agreement data sets it. */
export const CLEAR_YES = 0.95;
/** The most characters of one diff in a request, so a large change can't make it unaskable. */
export const MAX_DIFF = 40_000;
/** The branch's base, as the check agents read it. */
export const BASE = 'origin/staging';

/** `text`, cut at MAX_DIFF characters with a marker saying so. */
export function cut(text) {
  if (text.length <= MAX_DIFF) return text;
  return `${text.slice(0, MAX_DIFF)}\n… cut: ${text.length - MAX_DIFF} more characters`;
}

/** Runs git with `args` in the working directory: its stdout, or an empty text when git fails. */
export function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : '';
}

/** A noul question: yes is `yes`, no is `no`. */
export function noul(instructions, yes, no) {
  return { type: 'noul', instructions, criteria: { true: yes, false: no } };
}

/**
 * Asks Jev `questions` about `state` through `sail port jev ask`, the request kept as `jev-request.json` in `out`.
 * `{ asked: true, model, answers }`, or `{ asked: false, note }` when the port refuses, fails or answers nothing.
 */
export function askNouls(questions, state, out) {
  const file = join(out, 'jev-request.json');
  writeFileSync(file, JSON.stringify({ state, questions }));
  const result = spawnSync('sail', ['port', 'jev', 'ask', '--body-file', file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) return { asked: false, note: `sail port jev ask did not start: ${result.error.message}` };
  if (result.status !== 0) {
    const last = result.stderr.trim().split('\n').at(-1) || `exited ${result.status}`;
    return { asked: false, note: last };
  }
  try {
    const answered = JSON.parse(result.stdout.trim().split('\n').at(-1));
    return { asked: true, model: answered.model, answers: answered.answers ?? {} };
  } catch {
    return { asked: false, note: 'sail port jev ask printed no JSON answer' };
  }
}

/** Jev's probability of yes for each id in `ids` it answered, in that order. */
export function yesses(answers, ids) {
  return ids.flatMap((id) => {
    const answer = answers[id];
    return answer?.type === 'noul' && typeof answer.noul === 'number' ? [{ id, yes: answer.noul }] : [];
  });
}

/** Whether every id has an answer at or above CLEAR_YES (or `threshold`). No ids is never clear. */
export function clearYes(answers, ids, threshold = CLEAR_YES) {
  if (ids.length === 0) return false;
  const given = yesses(answers, ids);
  return given.length === ids.length && given.every((each) => each.yes >= threshold);
}

// --- jev-tasks: is each task of the plan implemented?

/** The paths a Files block names: the backticked tokens that look like files. */
function pathsOf(block) {
  const paths = [];
  for (const [, token] of block.matchAll(/`([^`\s]+)`/g)) {
    const path = token.replace(/:\d+(-\d+)?$/, '');
    if (/\//.test(path) || /\.(ts|tsx|js|mjs|json|md|yaml|yml|sh|css|html)$/.test(path)) {
      if (!paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

/** The `Files` block of a task's details: its line and what follows until a blank line or the next field. */
function filesBlock(lines) {
  const start = lines.findIndex((line) => /^Files:/.test(line));
  if (start === -1) return '';
  const block = [lines[start]];
  let i = start + 1;
  if (lines[start].replace(/^Files:/, '').trim() === '') while (i < lines.length && lines[i].trim() === '') i++;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '' || /^[A-Z][A-Za-z ]*:/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

/** Each `### TASK-nnn: title` of the plan's Task details: its id, text and the paths its Files block names. */
export function parseTasks(planText) {
  const start = planText.search(/^## Task details\s*$/m);
  if (start === -1) return [];
  const rest = planText.slice(start).replace(/^## Task details\s*\n/, '');
  const end = rest.search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const tasks = [];
  for (const part of section.split(/^(?=### TASK-\d{3}\b)/m)) {
    const heading = part.match(/^### (TASK-\d{3}): (.*)$/m);
    if (heading === null) continue;
    tasks.push({ id: heading[1], text: part.trim(), paths: pathsOf(filesBlock(part.split('\n'))) });
  }
  const list = planText.match(/^## Tasks\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? '';
  const ids = [...list.matchAll(/^- \[[ xX]\] (TASK-\d{3})\b/gm)].map((match) => match[1]);
  if (
    ids.length !== tasks.length ||
    new Set(ids).size !== ids.length ||
    tasks.some((task) => !ids.includes(task.id)) ||
    new Set(tasks.map((task) => task.id)).size !== tasks.length
  )
    return [];
  return tasks;
}

/** The state Jev judges tasks on: the branch's commits once, and each task's text with the diff of the files it names. */
export function tasksState(tasks, run = git) {
  const commits = run(['log', `${BASE}..HEAD`, '--format=%h %s']);
  let whole;
  const state = { commits, tasks: {} };
  for (const task of tasks) {
    let diff;
    if (task.paths.length > 0) diff = run(['diff', `${BASE}...HEAD`, '--', ...task.paths]);
    else diff = whole ??= run(['diff', `${BASE}...HEAD`]);
    state.tasks[task.id] = { text: task.text, diff };
  }
  return state;
}

/** One noul per task, named by its id. */
export function taskQuestions(tasks) {
  return Object.fromEntries(
    tasks.map((task) => [
      task.id,
      noul(
        `Is ${task.id} implemented on this branch? Read its text and its diff under tasks.${task.id} of the state, and the branch's commits.`,
        'A commit makes the change its details describe, in the files they name or the ones the code moved them to, with the tests an impl task calls for.',
        'No commit touches what it describes, or a commit covers only part of it.',
      ),
    ]),
  );
}

// --- jev-fix: is each targeted finding resolved?

/** The state Jev judges fixes on: the diff since the review began once, and each finding with the fix pass's note. */
export function fixState(findings, fixed, since, run = git) {
  const notes = new Map(fixed.fixes.map((each) => [each.finding, each]));
  const state = { diff: run(['diff', `${since}..HEAD`]), findings: {} };
  for (const finding of findings) {
    const fix = notes.get(finding.id);
    state.findings[finding.id] = { finding, fix: fix ?? null };
  }
  return state;
}

/** One noul per finding, named by its id. */
export function fixQuestions(findings) {
  return Object.fromEntries(
    findings.map((finding) => [
      finding.id,
      noul(
        `Is finding ${finding.id} resolved? Read the finding and the fix pass's note for it under findings.${finding.id} of the state, and the diff.`,
        'The problem the finding describes is gone: its trigger no longer goes wrong, and a commit in the diff fixes the cause, not only the symptom.',
        'The problem is still there, only its symptom is touched, or no commit in the diff addresses it.',
      ),
    ]),
  );
}
