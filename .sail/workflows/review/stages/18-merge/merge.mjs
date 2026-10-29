// Polls `sail port codehost checks` until every check on $INPUT_HEADSHA has passed or been skipped, then merges with
// `--expected-head-sha`. A pull request with no checks at all is merged once a few reads have found none, since CI may
// not have registered its run yet. Failed checks are rerun once, to rule out a flake. Still red, it reads each failed
// check's log and hands them back to the workflow as a retry, `checks`; a merge the host rejects, which a conflict with
// the base gives, is a retry too, `base`. On the last try ($INPUT_LASTTRY), a retry, a moved head, a refused merge, the
// time running out or a reason in $INPUT_BLOCKED instead comments why, swaps the label in $INPUT_LABEL for needs-human
// and exits 1. A merge after anything in $INPUT_LANDING, or after a rerun, comments what it took. Prints the Merged.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (name) => readFileSync(process.env[name], 'utf8');
const pr = JSON.parse(read('INPUT_PR'));
const headSha = read('INPUT_HEADSHA').trim();
const label = read('INPUT_LABEL').trim();
const lastTry = JSON.parse(read('INPUT_LASTTRY'));
const landing = JSON.parse(read('INPUT_LANDING'));
const blocked = process.env.INPUT_BLOCKED ? read('INPUT_BLOCKED').trim() : null;
// On fake ports the checks are scripted, so there's nothing to wait for.
const fake = /codeHost:\s*\{\s*use:\s*fake/.test(readFileSync(process.env.SAIL_CONFIG, 'utf8'));
const intervalMs = fake ? 100 : 30_000;
const emptyReads = fake ? 2 : 10;
const deadline = Date.now() + 55 * 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rerun = [];

/** Runs `sail port codehost …`: its parsed last line, or the error it printed. */
function port(args) {
  const result = spawnSync('sail', ['port', 'codehost', ...args], { encoding: 'utf8' });
  if (result.status !== 0) return { error: (result.stderr || `exit ${result.status}`).trim() };
  return { answer: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
}

/** What this landing took, as the comment's bullets: the workflow's, then the rerun. */
function taken() {
  const lines = [...landing];
  if (rerun.length > 0) lines.push(`reran ${rerun.join(', ')} once`);
  return lines.map((line) => `- ${line}`).join('\n');
}

/** Comments `text` on the pull request, saying so on stderr when it can't. */
function comment(text) {
  const body = join(process.env.STAGE_OUT, 'landing.md');
  writeFileSync(body, text);
  const commented = port(['comment', String(pr.number), '--body-file', body]);
  if (commented.error) process.stderr.write(`the comment failed: ${commented.error}\n`);
}

/** Comments why the merge didn't happen, takes the label off, prints the Merged and exits 1. */
function fail(reason) {
  process.stderr.write(`${reason}\n`);
  const tried = landing.length + rerun.length > 0 ? `\n\nBefore that, the review:\n\n${taken()}\n` : '\n';
  comment(
    `## sail review\n\nNot merged: ${reason}${tried}\nThe \`${label}\` label is off and \`needs-human\` is on: this pull request needs a human.\n`,
  );
  const unlabelled = port(['remove-label', String(pr.number), label]);
  if (unlabelled.error) process.stderr.write(`removing the label failed: ${unlabelled.error}\n`);
  const labelled = port(['add-label', String(pr.number), 'needs-human']);
  if (labelled.error) process.stderr.write(`adding needs-human failed: ${labelled.error}\n`);
  console.log(JSON.stringify({ merged: false, sha: null, reason, retry: null, failed: [], rerun }));
  process.exit(1);
}

/** Hands `retry` back to the workflow, which fixes it and calls merge again: the last try fails instead. */
function retry(kind, reason, failed = []) {
  if (lastTry) fail(reason);
  process.stderr.write(`${reason}: handed back to the workflow\n`);
  console.log(JSON.stringify({ merged: false, sha: null, reason, retry: kind, failed, rerun }));
  process.exit(0);
}

if (blocked !== null) fail(blocked);

let empty = 0;
for (;;) {
  if (Date.now() > deadline) fail(`its checks were still pending after 55 minutes`);
  const { answer, error } = port(['checks', String(pr.number)]);
  if (error) fail(`its checks could not be read: ${error}`);
  if (answer.headSha !== headSha) fail(`its head moved to ${answer.headSha.slice(0, 7)} during the review`);
  const failed = answer.checks.filter((check) => check.status === 'failed');
  if (failed.length > 0 && rerun.length === 0) {
    const again = port(['rerun-checks', String(pr.number)]);
    if (again.error) process.stderr.write(`the rerun failed: ${again.error}\n`);
    else if (again.answer.rerun.length > 0) {
      rerun.push(...again.answer.rerun);
      process.stderr.write(`checks failed, rerun once: ${rerun.join(', ')}\n`);
      await sleep(intervalMs);
      continue;
    }
  }
  if (failed.length > 0) {
    const logs = failed.map((check) => {
      const log = port(['check-log', String(pr.number), check.name]);
      return { name: check.name, url: check.url ?? null, log: log.error ? `no log: ${log.error}` : log.answer.log };
    });
    retry('checks', `checks failed: ${failed.map((check) => check.url ?? check.name).join(', ')}`, logs);
  }
  const pending = answer.checks.filter((check) => check.status === 'pending');
  process.stderr.write(`checks: ${answer.checks.length - pending.length}/${answer.checks.length} done\n`);
  if (answer.checks.length > 0 && pending.length === 0) break;
  if (answer.checks.length === 0 && ++empty >= emptyReads) break;
  await sleep(intervalMs);
}

for (let tries = 1; ; tries++) {
  const { answer, error } = port(['merge', String(pr.number), '--method', 'merge', '--expected-head-sha', headSha]);
  if (error) retry('base', `the host rejected the merge: ${error}`);
  if (answer.state === 'merged') {
    if (landing.length + rerun.length > 0) comment(`## sail review\n\nMerged after the review:\n\n${taken()}\n`);
    console.log(JSON.stringify({ merged: true, sha: answer.sha, reason: 'merged', retry: null, failed: [], rerun }));
    process.exit(0);
  }
  if (answer.state === 'refused' || tries >= 10) fail(`the merge was ${answer.state}: ${answer.reason}`);
  process.stderr.write(`merge pending: ${answer.reason}\n`);
  await sleep(intervalMs);
}
