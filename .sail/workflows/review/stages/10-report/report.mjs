// Formats the ReviewRecord in $INPUT_RECORD as REVIEW.md, comments it on the pull request, and, when findings are
// still open, removes the designation label in $INPUT_LABEL. Prints whether it removed it.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (name) => readFileSync(process.env[name], 'utf8');
const record = JSON.parse(read('INPUT_RECORD'));
const pr = JSON.parse(read('INPUT_PR'));
const label = read('INPUT_LABEL').trim();
const cell = (text) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Runs `sail port …`, failing the step when it fails. */
function port(args) {
  const result = spawnSync('sail', ['port', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`sail port ${args.join(' ')}: ${result.stderr.trim()}`);
}

const decided = new Map((record.judgement?.decisions ?? []).map((each) => [each.finding, each]));
const commits = new Map();
for (const round of record.rounds) {
  for (const each of round.fixed.fixes) if (each.commit) commits.set(each.finding, each.commit.slice(0, 7));
}
const verdict = (id) => {
  const decision = decided.get(id);
  if (decision === undefined) return 'fix';
  return decision.verdict;
};

const lines = ['## sail review', ''];
lines.push(
  record.resolved
    ? 'Every finding to fix is fixed, and validation passes.'
    : `${record.open.length} finding${record.open.length === 1 ? '' : 's'} still open after ${record.rounds.length} fix round${record.rounds.length === 1 ? '' : 's'}: this pull request needs a human, and its \`${label}\` label is off.`,
  '',
);
if (record.judgement) lines.push(record.judgement.summary, '');
if (record.findings.length === 0) {
  lines.push(
    'No findings: validation passed, the demonstration showed every criterion, and no reviewer found anything.',
  );
} else {
  lines.push('| Finding | From | Severity | Verdict | |', '|---|---|---|---|---|');
  for (const finding of record.findings) {
    const id = finding.id;
    const rationale = decided.get(id)?.rationale ?? 'introduced by a fix';
    const note = commits.has(id) ? `\`${commits.get(id)}\` ${rationale}` : rationale;
    lines.push(
      `| ${id} ${cell(finding.title)} | ${finding.source} | ${finding.severity} | ${verdict(id)} | ${cell(note)} |`,
    );
  }
}
if (record.rounds.length > 0) {
  lines.push('', '### Fix rounds', '');
  for (const round of record.rounds) {
    const resolved = round.checked.items.filter((each) => each.resolved).length;
    lines.push(
      `- Round ${round.round}: ${round.fixed.fixes.filter((each) => each.commit).length} commits, ${resolved}/${round.checked.items.length} resolved, ${round.checked.findings.length} new problems, validation ${round.validated ? 'passed' : 'failed'}`,
    );
  }
}
if (record.open.length > 0) {
  lines.push('', '### Still open', '');
  for (const each of record.open) lines.push(`- ${each.finding}: ${cell(each.detail)}`);
}
lines.push('');

const body = join(process.env.STAGE_OUT, 'REVIEW.md');
writeFileSync(body, lines.join('\n'));
port(['codehost', 'comment', String(pr.number), '--body-file', body]);
if (!record.resolved) port(['codehost', 'remove-label', String(pr.number), label]);
console.log(JSON.stringify({ unlabelled: !record.resolved }));
