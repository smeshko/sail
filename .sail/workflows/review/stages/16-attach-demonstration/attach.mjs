// Finds what the demonstrate call left in its directory, a sibling of this call's under the run directory: each demo
// repository's `transcript.txt` and its screenshots (`*.png`). Without a transcript file, it writes the demonstration's
// own transcript to one. Each file is attached to the ticket in $INPUT_TICKETKEY through `sail port ticket-source
// attach`, then a comment lists each criterion with whether it was shown and its evidence, and links the attachments
// and the pull request. Prints the Shared.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const read = (name) => readFileSync(process.env[name], 'utf8');
const demonstration = JSON.parse(read('INPUT_DEMONSTRATION'));
const ticketKey = read('INPUT_TICKETKEY').trim();
const pr = JSON.parse(read('INPUT_PR'));
const out = process.env.STAGE_OUT;

/** Runs `sail port ticket-source …`: its last line parsed, or the error it printed. */
function port(args) {
  const result = spawnSync('sail', ['port', 'ticket-source', ...args], { encoding: 'utf8' });
  if (result.status === 0) return { answer: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
  return { error: (result.stderr || `exit ${result.status}`).trim().split('\n')[0] };
}

/** The demonstrate calls' directories: `<run>/<NN>-demonstrate/call-<n>/`, this call being `<run>/<NN>-<stage>/call-1/`. */
function demonstrateCalls() {
  const run = dirname(dirname(out));
  return readdirSync(run)
    .filter((name) => /^\d+-demonstrate$/.test(name))
    .flatMap((stage) =>
      readdirSync(join(run, stage))
        .filter((call) => /^call-\d+$/.test(call))
        .map((call) => join(run, stage, call)),
    );
}

/** Each demo repository's transcript and screenshots, with the title each is attached under. */
function artifacts() {
  const found = [];
  for (const call of demonstrateCalls()) {
    for (const demo of readdirSync(call).filter((name) => /^demo(-\d+)?$/.test(name))) {
      const dir = join(call, demo);
      if (!statSync(dir).isDirectory()) continue;
      const transcript = join(dir, 'transcript.txt');
      if (existsSync(transcript)) found.push({ path: transcript, title: `Demonstration transcript (${demo})` });
      for (const name of readdirSync(dir)
        .filter((each) => each.endsWith('.png'))
        .sort()) {
        found.push({ path: join(dir, name), title: `Demonstration: ${name} (${demo})` });
      }
    }
  }
  if (!found.some((each) => each.path.endsWith('transcript.txt')) && demonstration.transcript.trim() !== '') {
    const path = join(out, 'transcript.txt');
    writeFileSync(path, `${demonstration.transcript.trim()}\n`);
    found.unshift({ path, title: 'Demonstration transcript' });
  }
  return found;
}

const attached = [];
const failed = [];
for (const { path, title } of artifacts()) {
  const { answer, error } = port(['attach', ticketKey, '--file', path, '--title', title]);
  if (answer) attached.push({ name: title, url: answer.url });
  else failed.push({ name: basename(path), error });
  process.stderr.write(answer ? `attached ${title}\n` : `failed: ${title}: ${error}\n`);
}

const cell = (text) => text.replace(/\n/g, ' ');
const lines = [`Demonstration of ${pr.url}`, ''];
if (demonstration.skipped !== null) lines.push(`Nothing to show: ${cell(demonstration.skipped)}`, '');
for (const each of demonstration.criteria) {
  lines.push(`- ${each.shown ? 'Shown' : '**Not shown**'}: ${cell(each.criterion)}`, `  ${cell(each.evidence)}`);
}
if (attached.length > 0) lines.push('', 'Attached:', ...attached.map((each) => `- [${each.name}](${each.url})`));
if (failed.length > 0) lines.push('', 'Not attached:', ...failed.map((each) => `- ${each.name}: ${each.error}`));
const body = join(out, 'comment.md');
writeFileSync(body, `${lines.join('\n')}\n`);
const { error } = port(['comment', ticketKey, '--body-file', body]);
if (error) process.stderr.write(`the ticket comment failed: ${error}\n`);
console.log(JSON.stringify({ attached, failed, commented: error === undefined }));
