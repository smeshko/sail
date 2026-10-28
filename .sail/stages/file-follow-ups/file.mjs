// Files each follow-up in $INPUT_FOLLOWUPS as a ticket: its type as a label, `code-review` too for a deferred review
// finding, and `groom`, so the groom workflow judges whether it earns its place; never the factory's designation label,
// which would hand it to the next run. Each description ends with where it
// came from. A pull request comment then lists the tickets, and the failures. Prints the Filed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const read = (name) => readFileSync(process.env[name], 'utf8');
const { followUps } = JSON.parse(read('INPUT_FOLLOWUPS'));
const pr = JSON.parse(read('INPUT_PR'));
const origin = read('INPUT_ORIGIN');
const scratch = mkdtempSync(join(tmpdir(), 'follow-ups-'));

/** Runs `sail port …` with the body in a file: its one line of JSON, or the error it printed. */
function port(args, body) {
  const bodyFile = join(scratch, 'body.md');
  writeFileSync(bodyFile, body);
  const result = spawnSync('sail', ['port', ...args, '--body-file', bodyFile], { encoding: 'utf8' });
  if (result.status === 0) return { answer: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
  return { error: (result.stderr || `exit ${result.status}`).trim() };
}

const filed = [];
const failed = [];
for (const { title, description, type, fromReview } of followUps) {
  const labels = [type, ...(fromReview ? ['code-review'] : []), 'groom'].flatMap((label) => ['--label', label]);
  const body = `${description}\n\nFrom ${origin}: ${pr.url}`;
  const { answer, error } = port(['ticket-source', 'create', '--title', title, ...labels], body);
  if (answer) filed.push({ title, ticketKey: answer.ticketKey, url: answer.url });
  else failed.push({ title, error });
  process.stderr.write(answer ? `filed ${answer.ticketKey}: ${title}\n` : `failed: ${title}: ${error}\n`);
}

if (filed.length + failed.length > 0) {
  const lines = [
    'Follow-ups:',
    '',
    ...filed.map((each) => `- [${each.ticketKey}](${each.url}) ${each.title}`),
    ...failed.map((each) => `- not filed: ${each.title} (${each.error.split('\n')[0]})`),
  ];
  const { error } = port(['codehost', 'comment', String(pr.number)], `${lines.join('\n')}\n`);
  if (error) process.stderr.write(`the pull request comment failed: ${error}\n`);
}
console.log(JSON.stringify({ filed, failed }));
