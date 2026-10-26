// Polls `sail port codehost checks` until every check on $INPUT_HEADSHA has passed or been skipped, then merges with
// `--expected-head-sha`. A pull request with no checks at all is merged once a few reads have found none, since CI
// may not have registered its run yet. On a failed check, a moved head, a refused merge or the time running out, it
// comments why, removes the label in $INPUT_LABEL and exits 1. Prints the Merged.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (name) => readFileSync(process.env[name], 'utf8');
const pr = JSON.parse(read('INPUT_PR'));
const headSha = read('INPUT_HEADSHA').trim();
const label = read('INPUT_LABEL').trim();
// On fake ports the checks are scripted, so there's nothing to wait for.
const fake = /codeHost:\s*\{\s*use:\s*fake/.test(readFileSync(process.env.SAIL_CONFIG, 'utf8'));
const intervalMs = fake ? 100 : 30_000;
const emptyReads = fake ? 2 : 10;
const deadline = Date.now() + 55 * 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `sail port codehost …`: its parsed last line, or the error it printed. */
function port(args) {
  const result = spawnSync('sail', ['port', 'codehost', ...args], { encoding: 'utf8' });
  if (result.status !== 0) return { error: (result.stderr || `exit ${result.status}`).trim() };
  return { answer: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
}

/** Comments why the merge didn't happen, takes the label off, prints the Merged and exits 1. */
function fail(reason) {
  process.stderr.write(`${reason}\n`);
  const body = join(process.env.STAGE_OUT, 'not-merged.md');
  writeFileSync(
    body,
    `## sail review\n\nNot merged: ${reason}\n\nThe \`${label}\` label is off: this pull request needs a human.\n`,
  );
  const commented = port(['comment', String(pr.number), '--body-file', body]);
  if (commented.error) process.stderr.write(`the comment failed: ${commented.error}\n`);
  const unlabelled = port(['remove-label', String(pr.number), label]);
  if (unlabelled.error) process.stderr.write(`removing the label failed: ${unlabelled.error}\n`);
  console.log(JSON.stringify({ merged: false, sha: null, reason }));
  process.exit(1);
}

let empty = 0;
for (;;) {
  if (Date.now() > deadline) fail(`its checks were still pending after 55 minutes`);
  const { answer, error } = port(['checks', String(pr.number)]);
  if (error) fail(`its checks could not be read: ${error}`);
  if (answer.headSha !== headSha) fail(`its head moved to ${answer.headSha.slice(0, 7)} during the review`);
  const failed = answer.checks.filter((check) => check.status === 'failed');
  if (failed.length > 0) fail(`checks failed: ${failed.map((check) => check.url ?? check.name).join(', ')}`);
  const pending = answer.checks.filter((check) => check.status === 'pending');
  process.stderr.write(`checks: ${answer.checks.length - pending.length}/${answer.checks.length} done\n`);
  if (answer.checks.length > 0 && pending.length === 0) break;
  if (answer.checks.length === 0 && ++empty >= emptyReads) break;
  await sleep(intervalMs);
}

for (let tries = 1; ; tries++) {
  const { answer, error } = port(['merge', String(pr.number), '--method', 'merge', '--expected-head-sha', headSha]);
  if (error) fail(`the host rejected the merge: ${error}`);
  if (answer.state === 'merged') {
    console.log(JSON.stringify({ merged: true, sha: answer.sha, reason: 'merged' }));
    process.exit(0);
  }
  if (answer.state === 'refused' || tries >= 10) fail(`the merge was ${answer.state}: ${answer.reason}`);
  process.stderr.write(`merge pending: ${answer.reason}\n`);
  await sleep(intervalMs);
}
