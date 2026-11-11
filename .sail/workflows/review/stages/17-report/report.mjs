// Formats the ReviewRecord in $INPUT_RECORD as REVIEW.md, the full report, and comments it on the pull request as
// COMMENT.md: the same text when it fits 60,000 bytes, a shortened one otherwise that names REVIEW.md in this run's output.
// Then, when findings are
// still open or a review was too thin to trust, swaps the designation label in $INPUT_LABEL for needs-human. Prints
// whether it removed it.
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

const mergeable = record.resolved && record.thin.length === 0;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const why = [
  ...(record.resolved
    ? []
    : [`${plural(record.open.length, 'finding')} still open after ${plural(record.rounds.length, 'fix round')}`]),
  ...(record.thin.length === 0 ? [] : [`${plural(record.thin.length, 'review')} too thin to trust`]),
];

/** The longest a comment may be, in UTF-8 bytes: under GitHub's 65,536 however the host counts. */
const MAX_BYTES = 60_000;
const CUT = 200;
const cut = (text) => {
  const chars = [...text];
  return chars.length > CUT ? `${chars.slice(0, CUT - 1).join('')}…` : text;
};
const bytes = (lines) => Buffer.byteLength(lines.join('\n'));
const open = new Set(record.open.map((each) => each.finding));
/** A finding is kept as a row when it is to be fixed or is still open. */
const kept = (finding) => verdict(finding.id) === 'fix' || open.has(finding.id);
const rule = (finding) =>
  finding.source === 'leak-check' || finding.source === 'banned-words' ? finding.title.split(':')[0] : '';

/** The findings as a counts table: one row per source, rule and verdict. */
function counts(findings) {
  const rows = new Map();
  for (const finding of findings) {
    const key = JSON.stringify([finding.source, rule(finding), verdict(finding.id)]);
    rows.set(key, (rows.get(key) ?? 0) + 1);
  }
  return [
    '| From | Rule | Verdict | Findings |',
    '|---|---|---|---|',
    ...[...rows].map(([key, count]) => {
      const [source, name, decision] = JSON.parse(key);
      return `| ${cell(source)} | ${cell(name)} | ${decision} | ${count} |`;
    }),
  ];
}

/**
 * The report at a level of detail: 1 is whole; 2 collapses the findings that are neither to be fixed nor open to
 * counts; 3 also cuts long text to CUT characters; 4 collapses every finding to counts and reduces `Still open` to one
 * line. Each level is shorter than the one before, and 4 is bounded by the number of sources, rules and verdicts.
 */
function build(level) {
  const short = level >= 3;
  const text = (value) => (short ? cut(value) : value);
  const rows = level >= 4 ? [] : level >= 2 ? record.findings.filter(kept) : record.findings;
  const collapsed = record.findings.filter((finding) => !rows.includes(finding));
  const lines = ['## sail review', ''];
  lines.push(
    mergeable
      ? 'Every finding to fix is fixed, and validation passes.'
      : `${why.join(', and ')}: this pull request needs a human: its \`${label}\` label is off and \`needs-human\` is on.`,
    '',
  );
  if (level >= 2)
    lines.push(
      `This report was shortened to fit a comment: ${plural(collapsed.length, 'finding')} ${collapsed.length === 1 ? 'is' : 'are'} collapsed to counts. The full report is \`REVIEW.md\` in the output of the report call of run ${process.env.RUN_ID}.`,
      '',
    );
  if (record.judgement) lines.push(text(record.judgement.summary), '');
  if (record.bannedWordsNote) lines.push(`Banned-words check incomplete: ${cell(record.bannedWordsNote)}.`, '');
  if (record.findings.length === 0) {
    lines.push(
      'No findings: validation passed, the leak check found nothing, the banned-words check returned no flagged hits, the demonstration showed every criterion, and no reviewer found anything.',
    );
  } else {
    if (rows.length > 0) {
      lines.push('| Finding | From | Severity | Verdict | |', '|---|---|---|---|---|');
      for (const finding of rows) {
        const id = finding.id;
        const rationale = decided.get(id)?.rationale ?? 'introduced by a fix';
        const note = commits.has(id) ? `\`${commits.get(id)}\` ${rationale}` : rationale;
        lines.push(
          `| ${id} ${cell(text(finding.title))} | ${finding.source} | ${finding.severity} | ${verdict(id)} | ${cell(text(note))} |`,
        );
      }
    }
    if (collapsed.length > 0) lines.push(...(rows.length > 0 ? [''] : []), ...counts(collapsed));
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
  if (record.thin.length > 0) {
    lines.push('', '### Reviews too thin to trust', '');
    for (const each of record.thin) lines.push(`- ${each.lens}: ${cell(text(each.why))}`);
  }
  if (record.open.length > 0) {
    lines.push('', '### Still open', '');
    if (level >= 4) lines.push(`${plural(record.open.length, 'finding')} open: see the full report.`);
    else for (const each of record.open) lines.push(`- ${each.finding}: ${cell(text(each.detail))}`);
  }
  lines.push('');
  return lines;
}

/** The first level that fits; failing all, level 4's lines taken whole while they fit, then a line saying the rest was cut. */
function comment() {
  for (let level = 2; level <= 4; level++) {
    const lines = build(level);
    if (bytes(lines) <= MAX_BYTES) return lines;
  }
  const notice = 'The rest of this report was cut to fit a comment.';
  const lines = build(4);
  const taken = [];
  for (const line of lines) {
    if (bytes([...taken, line, notice]) > MAX_BYTES) break;
    taken.push(line);
  }
  return [...taken, notice, ''];
}

const full = build(1);
const out = process.env.STAGE_OUT;
writeFileSync(join(out, 'REVIEW.md'), full.join('\n'));
const posted = bytes(full) <= MAX_BYTES ? full : comment();
const body = join(out, 'COMMENT.md');
writeFileSync(body, posted.join('\n'));
port(['codehost', 'comment', String(pr.number), '--body-file', body]);
if (!mergeable) {
  port(['codehost', 'remove-label', String(pr.number), label]);
  port(['codehost', 'add-label', String(pr.number), 'needs-human']);
}
console.log(JSON.stringify({ unlabelled: !mergeable }));
