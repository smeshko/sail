// Shared Jev requests, answer readers and state builders for leak-check, banned-words, jev-tasks and jev-fix.
// The task and fix checks hand the agent's job to Jev only when every item is a clear yes; otherwise the agent checks.
// Leak-check instead asks whether added lines name other projects and forwards individual LEAK_YES hits to the judge,
// with no agent fallback. The agreement script uses these same state builders.
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

// --- leak-check: does each added line name another project?

/** Provisional until ADW-416 calibrates it. */
export const LEAK_YES = 0.8;
export const SAIL_NOTE =
  'sail is a public open-source software factory. Its own names are sail, its Linear team ADW, ADW-<n> issues and test keys such as FAKE-1. Its providers and tools include Linear, GitHub, Anthropic, Claude, Claude Code, TypeSafe, Jev, System One, pi, OpenAI, Codex, ChatGPT, Jira, Bun, Node, TypeScript, Biome, Zod, git and macOS.';

export function leakLines(diffText) {
  const lines = [];
  let file = '';
  let line = 0;
  for (const text of diffText.split('\n')) {
    if (text.startsWith('+++ ')) {
      file = text === '+++ /dev/null' ? '' : text.slice(4).replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (text.startsWith('-') || text.startsWith('\\')) continue;
    if (text.startsWith('+') && file && !/\.json$/i.test(file)) {
      const added = text.slice(1);
      const trimmed = added.trim();
      const doc = /\.(md|mdx|txt|rst|adoc)$/i.test(file);
      const hash =
        /\.(sh|bash|yaml|yml|toml|py|rb)$/i.test(file) ||
        /(^|\/)Dockerfile$/.test(file) ||
        !file.split('/').at(-1).includes('.');
      if (/[a-z]/i.test(trimmed) && (doc || /^(\/\/|\/\*|\*|<!--)/.test(trimmed) || (hash && /^#(?!!)/.test(trimmed))))
        lines.push({ file, line, text: added });
    }
    line++;
  }
  return lines;
}

export function commitLines(log) {
  const lines = [];
  for (const record of log.split('\x1e')) {
    const zero = record.indexOf('\0');
    if (zero < 0) continue;
    const file = `commit ${record.slice(0, zero).trim()}`;
    record
      .slice(zero + 1)
      .split('\n')
      .forEach((text, index) => {
        if (/[a-z]/i.test(text)) lines.push({ file, line: index + 1, text });
      });
  }
  return lines;
}

export function leakState(lines) {
  return { note: SAIL_NOTE, lines: Object.fromEntries(lines.map((line, i) => [`leak-${i + 1}`, line])) };
}
export function leakQuestions(lines) {
  return Object.fromEntries(
    lines.map((line, i) => {
      const id = `leak-${i + 1}`;
      return [
        id,
        noul(
          `Does lines.${id} name a project, company, product or issue tracker other than sail, or a private ticket?`,
          'A name the note does not list as sail’s own or as a tool sail integrates with.',
          'Only sail’s names, those tools, or generic words.',
        ),
      ];
    }),
  );
}

// --- banned-words: is each avoided word used in the sense the glossary forbids?

/** Provisional until ADW-416 calibrates it. */
export const BANNED_YES = 0.8;
export const BANNED_CONTEXT = 3;

export function parseGlossary(text) {
  const entries = [];
  let entry;
  for (const line of text.split('\n')) {
    const heading = /^\*\*(.+?)\*\*:\s*$/.exec(line);
    if (heading) {
      entry = { term: heading[1], definition: [], avoid: [] };
      continue;
    }
    if (!entry) continue;
    const avoid = /^_Avoid_:\s*(.*)$/.exec(line);
    if (!avoid) {
      if (/^#/.test(line)) entry = undefined;
      else entry.definition.push(line);
      continue;
    }
    let depth = 0;
    let item = '';
    const items = [];
    for (const char of `${avoid[1]},`) {
      if (char === '(') depth++;
      if (char === ')') depth--;
      if ((char === ',' || char === ';') && depth === 0) {
        items.push(item);
        item = '';
      } else if (depth === 0 && char !== ')') item += char;
    }
    for (const value of items) {
      const clean = value.trim();
      const quoted = [...clean.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      if (quoted.length) entry.avoid.push(...quoted);
      else if (clean && !/^(using|and)\s/i.test(clean) && clean.split(/\s+/).length <= 3) entry.avoid.push(clean);
    }
    entries.push({
      term: entry.term,
      definition: entry.definition.join('\n').trim(),
      avoid: [...new Set(entry.avoid)],
      avoidText: avoid[1],
    });
    entry = undefined;
  }
  return entries;
}

export function bannedLines(diffText) {
  const lines = [];
  let file = '';
  let line = 0;
  let hunk = [];
  function flush() {
    for (const each of hunk) {
      if (each.added)
        lines.push({
          file,
          line: each.line,
          text: each.text,
          context: hunk
            .filter((other) => other !== each && Math.abs(other.line - each.line) <= BANNED_CONTEXT)
            .map(({ line, text }) => ({ line, text })),
        });
    }
    hunk = [];
  }
  for (const text of diffText.split('\n')) {
    if (text.startsWith('+++ ')) {
      flush();
      file = text.slice(4).replace(/^b\//, '');
      if (
        file === '/dev/null' ||
        /^(CONTEXT\.md|bun\.lock)$/.test(file) ||
        /\.(ndjson|json)$/i.test(file) ||
        /^(types\/|test\/fixtures\/(runs\/|terminal\/|dashboard\/views\/))/.test(file)
      )
        file = '';
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      flush();
      line = Number(header[1]);
    } else if (file && (text.startsWith('+') || text.startsWith(' '))) {
      hunk.push({ line: line++, text: text.slice(1), added: text.startsWith('+') });
    }
  }
  flush();
  return lines;
}

export function messageContext(lines) {
  return lines.map((each) => ({
    ...each,
    context: lines
      .filter(
        (other) => other !== each && other.file === each.file && Math.abs(other.line - each.line) <= BANNED_CONTEXT,
      )
      .map(({ line, text }) => ({ line, text })),
  }));
}

export function bannedCandidates(lines, glossary) {
  const patterns = glossary.flatMap((entry) =>
    entry.avoid.map((word) => ({
      entry,
      word,
      pattern: new RegExp(
        `(?<![\\w-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\w-])`,
        'i',
      ),
    })),
  );
  return lines.flatMap((line) =>
    patterns.filter(({ pattern }) => pattern.test(line.text)).map(({ entry, word }) => ({ ...line, ...entry, word })),
  );
}
export function bannedState(candidates) {
  return { candidates: Object.fromEntries(candidates.map((candidate, i) => [`word-${i + 1}`, candidate])) };
}
export function bannedQuestions(candidates) {
  return Object.fromEntries(
    candidates.map((candidate, i) => [
      `word-${i + 1}`,
      noul(
        `In candidates.word-${i + 1}, is "${candidate.word}" used in the sense the glossary entry for ${candidate.term} forbids, where "${candidate.term}" should be used instead?`,
        'The word names what the glossary entry defines, so the entry’s term belongs there.',
        'The word means something else, is mentioned as a word, or is a name the line cannot change, such as a language keyword or another system’s API.',
      ),
    ]),
  );
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
