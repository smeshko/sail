// Applies the actions in $INPUT_ACTIONS to the ticket in $INPUT_TICKETKEY, comments report.md, an `## Open questions`
// section rendered from the plan's questions and an `## Actions` section on it, then swaps the label in $INPUT_LABEL for the plan's outcome, `groomed` or `open-questions`. The swap is
// tried three times, a second apart, as open.sh does for its comment, so a short provider failure after the report is
// posted does not fail the step. The report ends with a line naming the run, and the step reads the ticket first and
// comments only when no comment holds that line: a later try has a fresh $STAGE_OUT, so the guard lives on the ticket.
// When the report was already posted, `comment` in the output is the ticket's URL. An action
// the port refuses is listed as failed and stops nothing. The comment goes before the labels, so a run that fails before
// the end leaves the ticket designated. Every action sets a whole value (a description, a state, a relation, a label), so
// a retry that applies it again changes nothing. Prints the Acted.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const read = (name) => readFileSync(process.env[name], 'utf8');
const ticketKey = read('INPUT_TICKETKEY').trim();
const label = read('INPUT_LABEL').trim();
const plan = JSON.parse(read('INPUT_ACTIONS'));
const report = read('INPUT_REPORT').trimEnd();

/** Each label group AGENTS.md names: a `labels` action takes off the group's other labels before it adds its own. */
const GROUPS = {
  type: ['feature', 'bug', 'refactoring'],
  platform: ['core', 'cli', 'dashboard'],
  source: ['dogfooding', 'code-review', 'field-report'],
};

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

/** Runs `port(args)` up to three times, a second apart, and fails with the third failure. */
function tried(args) {
  for (let attempt = 1; ; attempt++) {
    try {
      return port(args);
    } catch (error) {
      if (attempt === 3) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'groom-'));

/** Sets `key`'s description from a file, so a description of any size and character reaches the port intact. */
function describe(key, description, title) {
  const args = ['ticket-source', 'edit', key];
  if (description !== undefined) {
    const bodyFile = join(scratch, 'description.md');
    writeFileSync(bodyFile, description);
    args.push('--body-file', bodyFile);
  }
  if (title !== undefined) args.push('--title', title);
  port(args);
}

/** Applies one action through the port: what it did, as the Actions section words it. */
function apply(action) {
  if (action.kind === 'edit') {
    // A title-only edit sends no body, so the description stays as it is.
    describe(ticketKey, action.description, action.title);
    const fields = [action.title !== undefined && 'title', action.description !== undefined && 'description'];
    return `edit ${fields.filter(Boolean).join(' and ')}`;
  }
  if (action.kind === 'cancel') {
    port(['ticket-source', 'update', ticketKey, '--state', 'canceled']);
    return `cancel (${action.reason})`;
  }
  if (action.kind === 'merge') {
    // The survivor takes in every ask before any ticket is canceled, so a failure midway loses none of them.
    describe(action.into, action.description);
    for (const key of action.absorb) port(['ticket-source', 'relate', key, '--kind', 'duplicate', '--to', action.into]);
    return `merge ${action.absorb.join(', ')} into ${action.into}`;
  }
  if (action.kind === 'labels') {
    const chosen = [action.set.type, action.set.platform, action.set.source].filter((name) => name !== undefined);
    // Linear lets a ticket carry one label of each group, so the group's others come off first.
    for (const name of Object.values(GROUPS).flat()) {
      if (!chosen.includes(name)) port(['ticket-source', 'remove-label', ticketKey, name]);
    }
    for (const name of chosen) port(['ticket-source', 'add-label', ticketKey, name]);
    return `labels ${chosen.join(', ')}`;
  }
  const other = action.kind === 'duplicate' ? action.of : action.to;
  port(['ticket-source', 'relate', ticketKey, '--kind', action.kind, '--to', other]);
  return `${action.kind} ${other}`;
}

/** The action as the Actions section names it before it is applied. */
function named(action) {
  if (action.kind === 'edit' || action.kind === 'cancel' || action.kind === 'labels') return action.kind;
  if (action.kind === 'merge') return `merge ${action.absorb.join(', ')} into ${action.into}`;
  return `${action.kind} ${action.kind === 'duplicate' ? action.of : action.to}`;
}

const applied = [];
const failed = [];
for (const action of plan.apply) {
  try {
    applied.push(apply(action));
  } catch (error) {
    failed.push(`${named(action)} (${(error.reason ?? error.message).split('\n')[0]})`);
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
section.push('', `Labelled \`${plan.outcome}\`.`);

/** The questions as a numbered list: each option with what it means, the recommended one marked, then why and the cites. */
function questioned(questions) {
  if (questions.length === 0) return ['## Open questions', '', '- none'];
  const lines = ['## Open questions', ''];
  questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.ask}`);
    for (const { option, means } of question.options) {
      lines.push(
        option === question.recommend ? `  - **${option} (recommended)**: ${means}` : `  - ${option}: ${means}`,
      );
    }
    lines.push(`  Why: ${question.why} (${question.cites.map((cite) => `\`${cite}\``).join(', ')})`, '');
  });
  lines.pop();
  return lines;
}

const marker = `sail run ${process.env.RUN_ID} groomed this ticket.`;
const body = join(process.env.STAGE_OUT, 'comment.md');
writeFileSync(body, `${report}\n\n${questioned(plan.questions).join('\n')}\n\n${section.join('\n')}\n\n${marker}\n`);
const current = port(['ticket-source', 'get', ticketKey]);
const posted = current.comments.some((each) => each.body.split('\n').some((line) => line.trim() === marker));
const comment = posted ? { url: current.url } : port(['ticket-source', 'comment', ticketKey, '--body-file', body]);
tried(['ticket-source', 'add-label', ticketKey, plan.outcome]);
const relabelled = tried(['ticket-source', 'remove-label', ticketKey, label]);
console.log(
  JSON.stringify({
    applied,
    reported: plan.reported,
    failed,
    comment: comment.url,
    unlabelled: !relabelled.labels.includes(label),
    labelled: plan.outcome,
  }),
);
