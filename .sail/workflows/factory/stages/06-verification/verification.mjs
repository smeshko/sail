// The verification stage's script: puts a `## Verification` section, one entry per task that changed no file, into the
// pull request's body. It goes before a closing `Closes <ticket key>` line, which then still ends the body, else last.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_EVIDENCE = 4000;

const body = readFileSync(process.env.INPUT_BODY, 'utf8');
const tasks = JSON.parse(readFileSync(process.env.INPUT_TASKS, 'utf8'));

/** The evidence, trimmed and cut, in a fence one backtick longer than any run inside it (three at least). */
function fenced(evidence) {
  let text = evidence.trim();
  if (text.length > MAX_EVIDENCE) text = `${text.slice(0, MAX_EVIDENCE)}… (cut)`;
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

const section = [
  '## Verification',
  '',
  'What implement reported for each task that changed no file:',
  ...tasks.flatMap((task) => ['', `**${task.id}**`, '', fenced(task.evidence)]),
].join('\n');

const lines = body.trimEnd().split('\n');
const last = lines.at(-1) ?? '';
const result = /^Closes \S+$/.test(last)
  ? `${lines.slice(0, -1).join('\n').trimEnd()}\n\n${section}\n\n${last}\n`
  : `${body.trimEnd()}\n\n${section}\n`;

writeFileSync(join(process.env.STAGE_OUT, 'pr-body.md'), result);
console.log(JSON.stringify({ tasks: tasks.map((task) => task.id) }));
