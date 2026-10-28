// Comments report.md and an `## Actions` section on the ticket in $INPUT_TICKETKEY, then removes the label in
// $INPUT_LABEL. The comment goes before the label, so a run that fails before the end leaves the ticket designated.
// Prints the Acted.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (name) => readFileSync(process.env[name], 'utf8');
const ticketKey = read('INPUT_TICKETKEY').trim();
const label = read('INPUT_LABEL').trim();
const plan = JSON.parse(read('INPUT_ACTIONS'));
const report = read('INPUT_REPORT').trimEnd();

/** Runs `sail port …`, failing the step when it fails: its one line of JSON. */
function port(args) {
  const result = spawnSync('sail', ['port', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`sail port ${args.join(' ')}: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

const applied = [];
const failed = [];
const notApplied = plan.apply.map((action) => `not applied yet: ${action.kind}`);

const section = [
  '## Actions',
  '',
  ...[
    ...applied.map((line) => `- applied: ${line}`),
    ...notApplied.map((line) => `- ${line}`),
    ...plan.reported.map((line) => `- reported, not marked: ${line}`),
    ...failed.map((line) => `- failed: ${line}`),
  ],
];
if (section.length === 2) section.push('- none');

const body = join(process.env.STAGE_OUT, 'comment.md');
writeFileSync(body, `${report}\n\n${section.join('\n')}\n`);
const comment = port(['ticket-source', 'comment', ticketKey, '--body-file', body]);
const relabelled = port(['ticket-source', 'remove-label', ticketKey, label]);
console.log(
  JSON.stringify({
    applied,
    reported: plan.reported,
    failed,
    comment: comment.url,
    unlabelled: !relabelled.labels.includes(label),
  }),
);
