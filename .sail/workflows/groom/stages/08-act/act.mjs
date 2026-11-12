// Applies the actions in $INPUT_ACTIONS (the verdict) to the ticket in $INPUT_TICKETKEY. For a `planned` verdict it
// attaches $INPUT_PLAN, the plan.md the plan stage wrote, with an AttachedPlan trailer (.sail/lib/plan.ts) as its last
// line: the plan's structured part, this run, the commit the workspace stands on and when it was attached, which is how
// the factory finds the plan. Then it comments report.md, a `## Plan` section for a planned ticket, an `## Open questions`
// section rendered from the verdict's questions and an `## Actions` section on it, then swaps the label in $INPUT_LABEL
// for the verdict's outcome, `groomed`, `manual`, `open-questions`, or `planned` with `factory` beside it. The swap is
// tried three times, a second apart, as open.sh does for its comment, so a short provider failure after the report is
// posted does not fail the step. The report ends with a line naming the run, and the step reads the ticket first and
// comments only when no comment holds that line: a later try has a fresh $STAGE_OUT, so the guard lives on the ticket.
// When the report was already posted, `comment` in the output is the ticket's URL, and a plan already attached under
// this run's title is not attached again. An action
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
const verdict = JSON.parse(read('INPUT_ACTIONS'));
const report = read('INPUT_REPORT').trimEnd();
const planDoc = process.env.INPUT_PLAN ? read('INPUT_PLAN').trimEnd() : null;
if (verdict.outcome === 'planned' && (planDoc === null || verdict.plan === null)) {
  throw new Error('a planned verdict needs its plan.md and its plan');
}

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
  if (action.kind === 'manual') return `manual (${action.reason})`;
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
  if (action.kind === 'blocked_by') {
    // The port writes a blocked-by side from the other ticket: `to` blocks this one.
    port(['ticket-source', 'relate', action.to, '--kind', 'blocks', '--to', ticketKey]);
    return action.why === undefined ? `blocked_by ${action.to}` : `blocked_by ${action.to} (${action.why})`;
  }
  const other = action.kind === 'duplicate' ? action.of : action.to;
  port(['ticket-source', 'relate', ticketKey, '--kind', action.kind, '--to', other]);
  return `${action.kind} ${other}`;
}

/** The action as the Actions section names it before it is applied. */
function named(action) {
  if (['edit', 'cancel', 'labels', 'manual'].includes(action.kind)) return action.kind;
  if (action.kind === 'merge') return `merge ${action.absorb.join(', ')} into ${action.into}`;
  return `${action.kind} ${action.kind === 'duplicate' ? action.of : action.to}`;
}

const applied = [];
const failed = [];
for (const action of verdict.apply) {
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
  ...verdict.reported.map((line) => `- reported, not marked: ${line}`),
  ...failed.map((line) => `- failed: ${line}`),
];
if (section.length === 2) section.push('- none');
/** The labels the ticket ends with: the outcome, and `factory` beside `planned`, so the factory implements the plan. */
const outcomeLabels = verdict.outcome === 'planned' ? ['planned', 'factory'] : [verdict.outcome];
section.push('', `Labelled ${outcomeLabels.map((name) => `\`${name}\``).join(' and ')}.`);

/**
 * The questions as a numbered list: each option with what it means, the recommended one marked, then why and the cites.
 * Each sub-line is indented by its item's marker width, so it stays in the item, and a blank line keeps Why out of the
 * last option's bullet.
 */
function questioned(questions) {
  if (questions.length === 0) return ['## Open questions', '', '- none'];
  const lines = ['## Open questions', ''];
  questions.forEach((question, index) => {
    const marker = `${index + 1}. `;
    const indent = ' '.repeat(marker.length);
    lines.push(`${marker}${question.ask}`);
    for (const { option, means } of question.options) {
      lines.push(
        option === question.recommend
          ? `${indent}- **${option} (recommended)**: ${means}`
          : `${indent}- ${option}: ${means}`,
      );
    }
    lines.push('', `${indent}Why: ${question.why} (${question.cites.map((cite) => `\`${cite}\``).join(', ')})`, '');
  });
  lines.pop();
  return lines;
}

const current = port(['ticket-source', 'get', ticketKey]);

/**
 * Attaches plan.md with its AttachedPlan trailer, unless this run attached it already: the attachment's URL. The
 * trailer is one HTML comment, so the plan reads the same in Markdown, and the factory parses the line back.
 */
function attachPlan() {
  const title = `plan.md (sail run ${process.env.RUN_ID})`;
  const already = current.attachments.find((each) => each.name === title);
  if (already !== undefined) return already.url;
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (base.status !== 0) throw new Error(`git rev-parse HEAD: ${base.stderr.trim()}`);
  const trailer = {
    version: 1,
    ...verdict.plan,
    run: process.env.RUN_ID,
    base: base.stdout.trim(),
    attachedAt: new Date().toISOString(),
  };
  const file = join(process.env.STAGE_OUT, 'plan.md');
  writeFileSync(file, `${planDoc}\n\n<!-- sail:plan ${JSON.stringify(trailer)} -->\n`);
  const args = ['ticket-source', 'attach', ticketKey, '--file', file, '--title', title];
  return tried([...args, '--content-type', 'text/markdown']).url;
}

const attached = verdict.outcome === 'planned' ? attachPlan() : null;

/** The plan's risk and tasks, so a reader of the comment sees what the factory will do without opening the file. */
function planned() {
  if (verdict.plan === null || attached === null) return [];
  return [
    '## Plan',
    '',
    `Risk: ${verdict.plan.risk}. The factory implements the attached [plan.md](${attached}):`,
    '',
    ...verdict.plan.tasks.map((task) => `- ${task.id} (${task.type}): ${task.title}`),
    '',
  ];
}

const marker = `sail run ${process.env.RUN_ID} groomed this ticket.`;
const body = join(process.env.STAGE_OUT, 'comment.md');
writeFileSync(
  body,
  `${report}\n\n${[...planned(), ...questioned(verdict.questions)].join('\n')}\n\n${section.join('\n')}\n\n${marker}\n`,
);
const posted = current.comments.some((each) => each.body.split('\n').some((line) => line.trim() === marker));
const comment = posted ? { url: current.url } : port(['ticket-source', 'comment', ticketKey, '--body-file', body]);
for (const name of outcomeLabels) tried(['ticket-source', 'add-label', ticketKey, name]);
// A regroomed ticket can carry `factory`; a manual ticket is not the factory's.
if (verdict.outcome === 'manual') tried(['ticket-source', 'remove-label', ticketKey, 'factory']);
// A ticket ruled manual before and groomed to another outcome now is no longer waiting on a person.
else if (current.labels.includes('manual')) tried(['ticket-source', 'remove-label', ticketKey, 'manual']);
const relabelled = tried(['ticket-source', 'remove-label', ticketKey, label]);
console.log(
  JSON.stringify({
    applied,
    reported: verdict.reported,
    failed,
    comment: comment.url,
    unlabelled: !relabelled.labels.includes(label),
    labelled: outcomeLabels,
    attached,
  }),
);
