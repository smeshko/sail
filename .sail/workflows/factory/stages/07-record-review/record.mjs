// Formats the review rounds in $INPUT_HISTORY as REVIEW.md: the rounds with their verdict counts, then every finding
// by verdict, with its commit or its rationale. It has no title and its sections are level 3: the pull request's body
// holds it under its own `## Review`.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { rounds } = JSON.parse(readFileSync(process.env.INPUT_HISTORY, 'utf8'));
const cell = (text) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const rows = rounds.flatMap((round) =>
  round.findings.map((finding) => {
    const triage = round.triage.find((each) => each.finding === finding.id);
    return {
      ...finding,
      verdict: triage?.verdict ?? 'untriaged',
      rationale: triage?.rationale ?? '',
      commit: triage?.commit,
    };
  }),
);
const count = (round, verdict) => round.triage.filter((each) => each.verdict === verdict).length;
const listed = (verdict, line) => {
  const found = rows.filter((row) => row.verdict === verdict);
  return found.length === 0 ? ['None.'] : found.map(line);
};

const last = rounds.at(-1);
const unchecked = last?.triage.some((each) => each.verdict === 'fix') ?? false;
const lines = [
  `${rounds.length} adversarial round${rounds.length === 1 ? '' : 's'}.`,
  ...(unchecked ? ['', `Round ${last.round} still fixed findings, and no later round reviewed those fixes.`] : []),
  '',
  '| Round | Findings | Fixed | Deferred | Rejected |',
  '|---|---|---|---|---|',
  ...rounds.map(
    (round) =>
      `| ${round.round} | ${round.findings.length} | ${count(round, 'fix')} | ${count(round, 'defer')} | ${count(round, 'reject')} |`,
  ),
  '',
  '### Fixes',
  '',
  ...listed('fix', (row) => `- \`${row.commit?.slice(0, 7) ?? '?'}\` ${cell(row.title)} (${row.id}, ${row.severity})`),
  '',
  '### Deferred',
  '',
  ...listed('defer', (row) => `- ${cell(row.title)} (${row.id}, ${row.severity}): ${cell(row.rationale)}`),
  '',
  '### Rejected',
  '',
  ...listed('reject', (row) => `- ${cell(row.title)} (${row.id}, ${row.severity}): ${cell(row.rationale)}`),
  '',
];
writeFileSync(join(process.env.STAGE_OUT, 'REVIEW.md'), lines.join('\n'));
const fixed = rows.filter((row) => row.verdict === 'fix').length;
const deferred = rows.filter((row) => row.verdict === 'defer').length;
console.log(JSON.stringify({ rounds: rounds.length, fixed, deferred }));
