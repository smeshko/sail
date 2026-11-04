// Downloads the files of the ticket in $INPUT_TICKETKEY through `sail port ticket-source download`, and finds each one
// that ends with groom's AttachedPlan trailer, `<!-- sail:plan {…} -->` (.sail/lib/plan.ts). The plan attached last, by
// its trailer's `attachedAt`, is copied to $STAGE_OUT/plan.md, and its trailer is the output's plan. With no plan, the
// step writes a plan.md saying so, prints a null plan and exits 1. A trailer that isn't JSON or lacks a field is passed
// over with a note, so one damaged attachment does not hide a sound one. A ticket that can't be read fails the step.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ticketKey = readFileSync(process.env.INPUT_TICKETKEY, 'utf8').trim();
const out = process.env.STAGE_OUT;

const result = spawnSync('sail', ['port', 'ticket-source', 'download', ticketKey, '--out', join(out, 'attachments')], {
  encoding: 'utf8',
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  throw new Error(`sail port ticket-source download ${ticketKey}: exit ${result.status ?? result.signal}`);
}
const { files } = JSON.parse(result.stdout.trim().split('\n').at(-1));

/** The trailer's line: the last line of the file, an HTML comment holding the AttachedPlan as JSON. */
const TRAILER = /^<!-- sail:plan (\{.*\}) -->$/;
const FIELDS = ['version', 'slug', 'scope', 'risk', 'tasks', 'run', 'base', 'attachedAt'];

const notes = [];
const plans = [];
for (const each of files) {
  if (each.path === undefined) continue;
  const text = readFileSync(each.path, 'utf8').trimEnd();
  const match = TRAILER.exec(text.split('\n').at(-1) ?? '');
  if (match === null) continue;
  let trailer;
  try {
    trailer = JSON.parse(match[1]);
  } catch {
    notes.push(`${each.name}: its sail:plan trailer is not JSON`);
    continue;
  }
  const missing = FIELDS.filter((field) => trailer?.[field] === undefined);
  if (missing.length > 0) {
    notes.push(`${each.name}: its sail:plan trailer lacks ${missing.join(', ')}`);
    continue;
  }
  plans.push({ name: each.name, text, trailer });
}

plans.sort((a, b) => String(a.trailer.attachedAt).localeCompare(String(b.trailer.attachedAt)));
const chosen = plans.at(-1);
if (chosen === undefined) {
  const note = [`${ticketKey} has no plan attached: label it groom, and groom plans it`, ...notes].join('; ');
  writeFileSync(join(out, 'plan.md'), `# No plan\n\n${note}\n`);
  console.log(JSON.stringify({ plan: null, note }));
  process.exit(1);
}
writeFileSync(join(out, 'plan.md'), `${chosen.text}\n`);
const others = plans.length - 1;
const note = [
  `${chosen.name}, attached ${chosen.trailer.attachedAt} by ${chosen.trailer.run}`,
  ...(others > 0 ? [`${others} older plan${others === 1 ? '' : 's'} passed over`] : []),
  ...notes,
].join('; ');
console.log(JSON.stringify({ plan: chosen.trailer, note }));
