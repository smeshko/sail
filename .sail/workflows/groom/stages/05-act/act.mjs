// Applies the actions in $INPUT_ACTIONS to the ticket in $INPUT_TICKETKEY, comments report.md and an `## Actions`
// section on it, then removes the label in $INPUT_LABEL. An action the port refuses is listed as failed and stops
// nothing. The comment goes before the label, so a run that fails before the end leaves the ticket designated.
// Prints the Acted.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const read = (name) => readFileSync(process.env[name], 'utf8');
const ticketKey = read('INPUT_TICKETKEY').trim();
const label = read('INPUT_LABEL').trim();
const plan = JSON.parse(read('INPUT_ACTIONS'));
const report = read('INPUT_REPORT').trimEnd();

/** Runs `sail port …`, failing the step when it fails: its one line of JSON. */
function port(args) {
  const result = spawnSync('sail', ['port', ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw Object.assign(new Error(`sail port ${args.join(' ')}: ${result.stderr.trim()}`), {
      reason: result.stderr.trim(),
    });
  }
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

const scratch = mkdtempSync(join(tmpdir(), 'groom-'));

/** Applies one action through the port: what it did, as the Actions section words it. */
function apply(action) {
  if (action.kind === 'edit') {
    // `edit` always sets the description, so a title-only edit sends the one the ticket has now.
    const description = action.description ?? port(['ticket-source', 'get', ticketKey]).description;
    const bodyFile = join(scratch, 'description.md');
    writeFileSync(bodyFile, description);
    const args = ['ticket-source', 'edit', ticketKey, '--body-file', bodyFile];
    if (action.title !== undefined) args.push('--title', action.title);
    port(args);
    const fields = [action.title !== undefined && 'title', action.description !== undefined && 'description'];
    return `edit ${fields.filter(Boolean).join(' and ')}`;
  }
  const other = action.kind === 'duplicate' ? action.of : action.to;
  port(['ticket-source', 'relate', ticketKey, '--kind', action.kind, '--to', other]);
  return `${action.kind} ${other}`;
}

const applied = [];
const failed = [];
for (const action of plan.apply) {
  const what =
    action.kind === 'edit' ? 'edit' : `${action.kind} ${action.kind === 'duplicate' ? action.of : action.to}`;
  try {
    applied.push(apply(action));
  } catch (error) {
    failed.push(`${what} (${(error.reason ?? error.message).split('\n')[0]})`);
  }
}

const section = [
  '## Actions',
  '',
  ...applied.map((line) => `- applied: ${line}`),
  ...plan.reported.map((line) => `- reported, not marked: ${line}`),
  ...failed.map((line) => `- failed: ${line}`),
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
